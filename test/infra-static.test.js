// Static checks on the live site's stack and deploy (infra/app.yaml, infra/www-stack-policy.json,
// .github/workflows/deploy.yml) for Tripelyx Business going live on www (stage L0, WS-B; the supplier keys of
// stage L2, WS-D).
// No YAML parser is installed, so these are careful text checks on the lines that matter, plus three runs:
// the deploy job's switch step and its page check are run under bash with stand-ins for aws (and, once,
// curl), and the app is booted with the www container's own environment from app.yaml.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawnSync } = require('node:child_process');
const { FIXED_NOW, sha256, normalise, stripBusiness, expectedBusinessCounts, freezeDate, bootApp } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('infra/app.yaml');
const workflow = read('.github/workflows/deploy.yml');
const policyText = read('infra/www-stack-policy.json');
const readme = read('README.md');

/** The file without its full-line comments. */
const code = text => text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

/** The non-blank, non-comment lines of the block that starts at `<indent>key:` and ends at the next line indented as little. */
function block(text, key, indent) {
  const lines = code(text).split('\n');
  const pad = ' '.repeat(indent);
  const start = lines.findIndex(l => l === `${pad}${key}:` || l.startsWith(`${pad}${key}: `));
  assert.ok(start >= 0, `${key}: is there`);
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim()) continue;
    if (l.search(/\S/) <= indent) break;
    out.push(l);
  }
  return out;
}

const section = name => block(app, name, 0).join('\n');
const resource = name => block(section('Resources'), name, 2);
const parameter = name => block(section('Parameters'), name, 2);
const typeOf = name => resource(name).find(l => /^ {4}Type: /.test(l)).trim().slice('Type: '.length);

/** A parameter's default, quotes removed. */
function paramDefault(name) {
  const line = parameter(name).find(l => /^ {4}Default: /.test(l));
  assert.ok(line, `${name} has a default`);
  return line.trim().slice('Default: '.length).replace(/^'(.*)'$/, '$1');
}

/** The `- { Name: X, Value|ValueFrom: Y }` items of a container block, in order. */
function pairs(lines, kind) {
  const start = lines.findIndex(l => l.trim() === `${kind}:`);
  if (start < 0) return [];
  const indent = lines[start].search(/\S/);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.search(/\S/) <= indent) break;
    const m = new RegExp(`^\\s+- \\{ Name: ([A-Z0-9_]+), ${kind === 'Secrets' ? 'ValueFrom' : 'Value'}: (.+) \\}$`).exec(l);
    assert.ok(m, `a ${kind} item: ${l}`);
    out.push([m[1], m[2]]);
  }
  return out;
}

/** The container definitions of a task definition resource: [{ name, lines }]. */
function containers(resourceName) {
  const lines = resource(resourceName);
  const start = lines.findIndex(l => l.trim() === 'ContainerDefinitions:');
  assert.ok(start >= 0);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^ {8}- Name: (\S+)$/.exec(l);
    if (m) out.push({ name: m[1], lines: [l] });
    else if (/^ {10}/.test(l) && out.length) out[out.length - 1].lines.push(l);
    else break;
  }
  return out;
}

/** The steps of the deploy job: [{ name, lines }] (a step without a name is named by its `uses:`). */
function deploySteps() {
  const all = workflow.split('\n');
  assert.ok(block(workflow, 'jobs', 0).includes('  deploy:'), 'the deploy job is there');
  const steps = [];
  for (const l of all.slice(all.indexOf('  deploy:') + 1)) {
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break;
    if (/^ {6}- /.test(l)) steps.push({ lines: [l] });
    else if (steps.length) steps[steps.length - 1].lines.push(l);
  }
  for (const s of steps) {
    const named = s.lines.map(l => /^ {6}[- ] name: (.+)$/.exec(l)).find(Boolean);
    const uses = s.lines.map(l => /^ {6}[- ] uses: (\S+)$/.exec(l)).find(Boolean);
    s.name = named ? named[1] : uses[1];
  }
  return steps;
}
const step = name => {
  const s = deploySteps().find(x => x.name === name);
  assert.ok(s, `the step "${name}" is there`);
  return s;
};

/** A step's `run: |` script, as GitHub hands it to bash (the block's indentation removed). */
function runScript(s) {
  const at = s.lines.findIndex(l => /^ {8}run: \|$/.test(l));
  assert.ok(at >= 0, `${s.name} has a run block`);
  const body = [];
  for (const l of s.lines.slice(at + 1)) {
    if (l.trim() && !/^ {10}/.test(l)) break;
    body.push(l.slice(10));
  }
  return body.join('\n').replace(/\n+$/, '\n');
}

/** The page check script the deploy job writes to $RUNNER_TEMP (the heredoc in "Page hashes before the deploy"). */
function pageCheckScript() {
  const script = runScript(step('Page hashes before the deploy')).split('\n');
  const start = script.indexOf(`cat > "$RUNNER_TEMP/page-check.sh" <<'SCRIPT'`);
  const end = script.indexOf('SCRIPT');
  assert.ok(start === 0 && end > start, 'the step writes the check script first');
  assert.deepEqual(script.slice(end + 1).filter(Boolean), ['bash "$RUNNER_TEMP/page-check.sh" before']);
  return script.slice(start + 1, end).join('\n') + '\n';
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tx-infra-'));
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const hasCurl = spawnSync('curl', ['--version']).status === 0;
/** The environment for a child shell: no proxy, so curl reaches 127.0.0.1 directly. */
function shellEnv(extra) {
  const env = { ...process.env, NO_PROXY: '*', no_proxy: '*', ...extra };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  return env;
}
function run(cmd, args, env) {
  return new Promise(resolve => {
    execFile(cmd, args, { env, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

// ---------- infra/app.yaml ----------

test('the www container runs Business without its demo inventory, and /book keeps the demo inventory it runs on', () => {
  const web = containers('TaskDefinition');
  assert.deepEqual(web.map(c => c.name), ['web']);
  const env = pairs(web[0].lines, 'Environment');
  assert.deepEqual(env.filter(([n]) => n === 'BUSINESS_DEMO_INVENTORY'), [['BUSINESS_DEMO_INVENTORY', "'false'"]], 'a literal false, not a parameter');
  assert.deepEqual(env.filter(([n]) => n === 'ALLOW_DEMO_INVENTORY'), [['ALLOW_DEMO_INVENTORY', '!Ref AllowDemoInventory']]);
  assert.deepEqual(env.filter(([n]) => n === 'ENABLE_BUSINESS'), [['ENABLE_BUSINESS', '!Ref EnableBusiness']]);
  assert.equal((app.match(/BUSINESS_DEMO_INVENTORY/g) || []).length, 1, 'set once, on the www container');
  assert.equal(paramDefault('AllowDemoInventory'), 'true', '/book, the trip planner and the agent keep their demo inventory');
  assert.equal(paramDefault('EnableBusiness'), 'false', 'Business is off unless a deploy says otherwise');
  for (const p of ['AllowDemoInventory', 'EnableBusiness', 'ProtectDatabase']) {
    assert.ok(parameter(p).includes("    AllowedValues: ['true', 'false']"), `${p} allows exactly 'true' and 'false'`);
  }
});

test('ProtectDatabase: deletion protection and 14-day backups in every environment, changed in place, Multi-AZ untouched', () => {
  assert.deepEqual(parameter('ProtectDatabase').slice(0, 4), ['  ProtectDatabase:', '    Type: String', "    AllowedValues: ['true', 'false']", "    Default: 'true'"]);
  assert.ok(block(app, 'Conditions', 0).includes("  Protected: !Or [!Condition IsProduction, !Equals [!Ref ProtectDatabase, 'true']]"));
  assert.ok(block(app, 'Conditions', 0).includes('  IsProduction: !Equals [!Ref AppEnv, production]'));
  // The whole Database resource, frozen: only BackupRetentionPeriod and DeletionProtection read the new
  // condition. Every property whose change needs a replacement (engine, name, user, subnet group,
  // encryption) is as it was, so this template modifies the instance in place and never replaces it.
  assert.deepEqual(resource('Database'), [
    '  Database:',
    '    Type: AWS::RDS::DBInstance',
    '    Metadata:',
    '      cfn-lint:',
    '        config:',
    '          ignore_checks: [W3691]',
    '    DeletionPolicy: Snapshot',
    '    UpdateReplacePolicy: Snapshot',
    '    Properties:',
    '      Engine: postgres',
    "      EngineVersion: '17'",
    '      DBInstanceClass: !Ref DbInstanceClass',
    "      AllocatedStorage: '20'",
    '      StorageType: gp3',
    '      StorageEncrypted: true',
    '      DBName: tripelyx',
    '      MasterUsername: tripelyx',
    '      ManageMasterUserPassword: true',
    '      DBSubnetGroupName: !Ref DatabaseSubnetGroup',
    '      VPCSecurityGroups: [!Ref DatabaseSecurityGroup]',
    '      PubliclyAccessible: false',
    '      MultiAZ: !If [IsProduction, true, false]',
    '      BackupRetentionPeriod: !If [Protected, 14, 3]',
    '      DeletionProtection: !If [Protected, true, false]',
    '      AutoMinorVersionUpgrade: true',
  ]);
  assert.equal(typeOf('DatabaseSubnetGroup'), 'AWS::RDS::DBSubnetGroup');
  // Unprotected is still 3 days, never 0: RDS only takes the database down between 0 days and some.
  assert.doesNotMatch(app, /BackupRetentionPeriod: !If \[\w+, \d+, 0\]/);
});

test('the admin task definition: its own family and container, the list command, the database and nothing else', () => {
  assert.equal(typeOf('AdminTaskDefinition'), 'AWS::ECS::TaskDefinition');
  const def = resource('AdminTaskDefinition');
  assert.ok(def.includes("      Family: !Sub 'tripelyx-${AppEnv}-admin'"));
  assert.ok(def.includes('      ExecutionRoleArn: !GetAtt AdminExecutionRole.Arn'));
  assert.ok(!def.some(l => /TaskRoleArn/.test(l)), 'no task role: the task has no AWS credentials at all');
  for (const l of ['      RequiresCompatibilities: [FARGATE]', '      NetworkMode: awsvpc']) assert.ok(def.includes(l), l);
  const [admin, ...others] = containers('AdminTaskDefinition');
  assert.equal(others.length, 0, 'one container');
  assert.equal(admin.name, 'admin');
  assert.ok(admin.lines.includes('          Image: !Ref ImageUri'), 'the same image as the site');
  assert.ok(admin.lines.includes('          Command: [node, scripts/platform-admin.js, list]'));
  assert.ok(!admin.lines.some(l => /PortMappings/.test(l)), 'it serves nothing');

  const env = pairs(admin.lines, 'Environment');
  assert.deepEqual(env.map(([n]) => n), ['APP_ENV', 'ADMIN_EMAILS', 'DATABASE_ENV', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_SSL', 'DATABASE_SSL_CA_FILE']);
  for (const [n] of env) assert.match(n, /^(APP_ENV|ADMIN_EMAILS|DATABASE_[A-Z_]+)$/);
  // Each value is exactly the one the site's own container gets, so the script reads the site's database.
  const web = new Map(pairs(containers('TaskDefinition')[0].lines, 'Environment'));
  for (const [n, v] of env) assert.equal(v, web.get(n), `${n} as on the web container`);

  assert.deepEqual(pairs(admin.lines, 'Secrets'), [
    ['DATABASE_USER', "!Sub '${Database.MasterUserSecret.SecretArn}:username::'"],
    ['DATABASE_PASSWORD', "!Sub '${Database.MasterUserSecret.SecretArn}:password::'"],
  ], 'the database secret only');

  const logs = admin.lines.slice(admin.lines.findIndex(l => l.trim() === 'LogConfiguration:'));
  assert.deepEqual(logs, [
    '          LogConfiguration:',
    '            LogDriver: awslogs',
    '            Options:',
    '              awslogs-group: !Ref LogGroup',
    '              awslogs-region: !Ref AWS::Region',
    '              awslogs-stream-prefix: admin',
  ]);
  assert.ok(resource('LogGroup').includes("      LogGroupName: !Sub '/tripelyx/${AppEnv}'"));
});

test('the admin execution role pulls the image, reads only the database secret and writes only its own log streams', () => {
  assert.equal(typeOf('AdminExecutionRole'), 'AWS::IAM::Role');
  const role = resource('AdminExecutionRole');
  const text = role.join('\n');
  assert.doesNotMatch(text, /ManagedPolicyArns|AmazonECSTaskExecutionRolePolicy|AdministratorAccess|RoleName:/, 'no managed policy (it allows every log group)');
  assert.match(text, /Principal: \{ Service: ecs-tasks\.amazonaws\.com \}\n\s+Action: sts:AssumeRole/);
  assert.equal((text.match(/Principal:/g) || []).length, 1);
  // Every statement, with its actions and resource.
  const statements = text.split(/\n\s+- Sid: /).slice(1).map(s => {
    const lines = s.split('\n');
    const actions = [...s.matchAll(/(?:Action: |- )([a-z0-9-]+:[A-Za-z*]+)$/gm)].map(m => m[1]);
    const res = lines.find(l => /^\s+Resource: /.test(l)).trim().slice('Resource: '.length);
    assert.match(s, /\n\s+Effect: Allow\n/);
    return { sid: lines[0], actions, resource: res };
  });
  assert.deepEqual(statements, [
    { sid: 'EcrLogin', actions: ['ecr:GetAuthorizationToken'], resource: "'*'" },
    { sid: 'PullAppImage', actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], resource: "!Sub 'arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/tripelyx'" },
    { sid: 'WriteAdminLogStreams', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resource: "!Sub 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${LogGroup}:log-stream:admin/*'" },
    { sid: 'ReadDatabaseSecret', actions: ['secretsmanager:GetSecretValue'], resource: '!GetAtt Database.MasterUserSecret.SecretArn' },
  ]);
  assert.doesNotMatch(text, /Effect: Deny|NotAction|NotResource|kms:|iam:|ssm:|s3:/);
  // The deploy pushes to this repository, so the role can pull what the task definition names.
  assert.match(workflow, /IMAGE: \$\{\{ steps\.ecr\.outputs\.registry \}\}\/tripelyx:\$\{\{ github\.sha \}\}\n/);
});

// ---------- Business supplier keys (stage L2, WS-D) ----------

const SUPPLIER_SECRETS = Object.freeze([
  { id: 'DuffelTokenSecret', policy: 'DuffelTokenSecretPolicy', env: 'DUFFEL_ACCESS_TOKEN', name: "!Sub 'tripelyx-${AppEnv}/business/duffel-token'" },
  { id: 'LiteApiKeySecret', policy: 'LiteApiKeySecretPolicy', env: 'LITEAPI_API_KEY', name: "!Sub 'tripelyx-${AppEnv}/business/liteapi-key'" },
]);

test('the two supplier key secrets: fixed names, the placeholder "unset" that is never edited, kept once created', () => {
  const body = code(app);
  assert.deepEqual([...body.matchAll(/Type: (AWS::SecretsManager::[A-Za-z]+)$/gm)].map(m => m[1]), [
    'AWS::SecretsManager::Secret', 'AWS::SecretsManager::Secret', 'AWS::SecretsManager::ResourcePolicy', 'AWS::SecretsManager::ResourcePolicy',
  ], 'two secrets and their two policies, nothing else');
  assert.doesNotMatch(body, /AWS::SSM::|AWS::KMS::|GenerateSecretString|RotationSchedule|RotationRules/, 'no other secret store, no generated value, no rotation');
  for (const { id, name } of SUPPLIER_SECRETS) {
    assert.equal(typeOf(id), 'AWS::SecretsManager::Secret');
    const r = resource(id);
    assert.deepEqual(r.filter(l => /^ {4}\S/.test(l)).map(l => l.trim()), [
      'Type: AWS::SecretsManager::Secret', 'DeletionPolicy: RetainExceptOnCreate', 'UpdateReplacePolicy: Retain', 'Properties:',
    ], `${id}: a rolled-back first create removes it, and once it exists it is kept`);
    const props = r.filter(l => /^ {6}\S/.test(l)).map(l => l.trim());
    assert.deepEqual(props.map(l => l.split(':')[0]), ['Name', 'Description', 'SecretString'], `${id}: no KmsKeyId, Tags or replica`);
    assert.equal(props[0], `Name: ${name}`);
    // A deploy only writes SecretString when this line changes, so the value the owner pasted survives
    // every deploy as long as the line stays exactly this.
    assert.equal(props[2], 'SecretString: unset', `${id}: the placeholder, never edited`);
  }
  assert.equal((body.match(/SecretString:/g) || []).length, 2);
  assert.equal((body.match(/^\s+SecretString: unset$/gm) || []).length, 2);
  assert.doesNotMatch(app, /\b(AKIA|ASIA)[0-9A-Z]{16}\b|duffel_(test|live)_|\bsand_[0-9a-f-]{8}|\bprod_[0-9a-z]{8}/i, 'no key or key-shaped value in the template');
  assert.doesNotMatch(app, /PII|BUSINESS_BOOKING|PREVIEW_/i, 'nothing from later stages');
});

test('only the site\'s execution role may read a supplier key: each secret has a deny-everyone-else resource policy', () => {
  for (const { id, policy } of SUPPLIER_SECRETS) {
    assert.equal(typeOf(policy), 'AWS::SecretsManager::ResourcePolicy');
    assert.deepEqual(resource(policy).slice(1).map(l => l.trimEnd()), [
      '    Type: AWS::SecretsManager::ResourcePolicy',
      '    Properties:',
      `      SecretId: !Ref ${id}`,
      '      BlockPublicPolicy: true',
      '      ResourcePolicy:',
      "        Version: '2012-10-17'",
      '        Statement:',
      '          - Sid: OnlyTheSiteReadsTheKey',
      '            Effect: Deny',
      "            Principal: '*'",
      '            Action: secretsmanager:GetSecretValue',
      "            Resource: '*'",
      '            Condition:',
      '              ArnNotEquals:',
      '                aws:PrincipalArn: !GetAtt ExecutionRole.Arn',
    ], `${policy}: a single deny on reading the value, for every principal but the www execution role`);
  }
  // No Allow in a resource policy: reading still needs the grant below, and no other account is ever named.
  assert.doesNotMatch(code(app), /arn:aws:iam::\d{12}:/, 'no hard-coded account or identity');
});

test('the www execution role reads exactly the database secret and the two supplier keys', () => {
  const role = resource('ExecutionRole').join('\n');
  const policies = role.slice(role.indexOf('      Policies:'));
  assert.match(role.slice(0, role.indexOf('      Policies:')), /Principal: \{ Service: ecs-tasks\.amazonaws\.com \}\n\s+Action: sts:AssumeRole\n\s+ManagedPolicyArns:/);
  assert.equal((policies.match(/PolicyName:/g) || []).length, 1, 'one inline policy');
  const statements = policies.split(/\n\s+- (?=Effect: |Sid: )/).slice(1).map(st => ({
    sid: (/^Sid: (\S+)/.exec(st) || [])[1] || null,
    effect: /Effect: (\w+)/.exec(st)[1],
    actions: [...st.matchAll(/Action: (\S+)$/gm)].map(m => m[1]),
    resource: /Resource: (.+)$/m.exec(st)[1],
  }));
  assert.deepEqual(statements, [
    { sid: null, effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resource: '!GetAtt Database.MasterUserSecret.SecretArn' },
    { sid: 'ReadSupplierKeys', effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resource: '[!Ref DuffelTokenSecret, !Ref LiteApiKeySecret]' },
  ]);
  assert.match(role, /ManagedPolicyArns:\n\s+- arn:aws:iam::aws:policy\/service-role\/AmazonECSTaskExecutionRolePolicy\n/);
  const reads = [...code(app).matchAll(/secretsmanager:[A-Za-z]+/g)].map(m => m[0]);
  assert.deepEqual(reads, Array(5).fill('secretsmanager:GetSecretValue'), 'two policies deny it, the web and admin execution roles allow it, nothing else');
  assert.doesNotMatch(resource('AdminExecutionRole').join('\n'), /DuffelTokenSecret|LiteApiKeySecret|SecretsManager::Secret/, 'the admin role reads no supplier key');
  assert.doesNotMatch(resource('TaskRole').join('\n'), /Policies|ManagedPolicyArns/, 'the site task role still has no policy');
});

test('the www container maps both keys and live search settings; the admin task definition maps no supplier key', () => {
  const web = containers('TaskDefinition')[0].lines;
  assert.deepEqual(pairs(web, 'Secrets'), [
    ['DATABASE_USER', "!Sub '${Database.MasterUserSecret.SecretArn}:username::'"],
    ['DATABASE_PASSWORD', "!Sub '${Database.MasterUserSecret.SecretArn}:password::'"],
    ['DUFFEL_ACCESS_TOKEN', '!Ref DuffelTokenSecret'],
    ['LITEAPI_API_KEY', '!Ref LiteApiKeySecret'],
  ], 'the whole secret each, no JSON key');
  const env = pairs(web, 'Environment');
  assert.deepEqual(env.filter(([n]) => /^BUSINESS_(FLIGHT|HOTEL)_SUPPLIER$|^BUSINESS_SUPPLIER_LIVE$|^BUSINESS_ALLOW_SUPPLIER_TEST$/.test(n)), [
    ['BUSINESS_FLIGHT_SUPPLIER', 'duffel'],
    ['BUSINESS_HOTEL_SUPPLIER', 'liteapi'],
    ['BUSINESS_SUPPLIER_LIVE', "'true'"],
    ['BUSINESS_ALLOW_SUPPLIER_TEST', "'false'"],
  ], 'literals, not parameters: no deploy setting can switch test data on');
  assert.ok(!env.some(([n]) => /DUFFEL|LITEAPI|_TOKEN$|_KEY$/.test(n)), 'no key in the plain environment');
  const admin = containers('AdminTaskDefinition')[0].lines.join('\n');
  assert.doesNotMatch(admin, /DUFFEL|LITEAPI|SUPPLIER|DuffelTokenSecret|LiteApiKeySecret/, 'one-off tasks never hold a supplier key');
  for (const { id } of SUPPLIER_SECRETS) {
    const uses = code(app).split('\n').filter(l => l.includes(id) && !/^ {2}\w+:$/.test(l)).map(l => l.trim());
    assert.deepEqual(uses.map(l => l.replace(/^- \{ Name: \w+, /, '{ ').replace(/^SecretId: /, 'SecretId: ')), [
      `SecretId: !Ref ${id}`,
      'Resource: [!Ref DuffelTokenSecret, !Ref LiteApiKeySecret]',
      `{ ValueFrom: !Ref ${id} }`,
    ], `${id} is used by its policy, the execution role grant and the www container only`);
  }
  assert.ok(!parameter('AppEnv').some(l => /supplier|duffel|liteapi/i.test(l)));
  assert.doesNotMatch(section('Parameters'), /supplier|duffel|liteapi|_TOKEN|_KEY\b/i, 'no stack parameter carries a key (NoEcho parameters are advised against)');
});

test('the resources the stack adds are the admin task definition and its role (L0), then the two keys and their policies (L2)', () => {
  const resources = section('Resources').split('\n').map(l => /^ {2}([A-Za-z0-9]+):$/.exec(l)).filter(Boolean).map(m => m[1]);
  assert.deepEqual(resources, [
    'Vpc', 'InternetGateway', 'GatewayAttachment', 'PublicSubnetA', 'PublicSubnetB', 'PrivateSubnetA', 'PrivateSubnetB',
    'PublicRouteTable', 'PublicRoute', 'PublicSubnetARoutes', 'PublicSubnetBRoutes', 'LoadBalancerSecurityGroup', 'AppSecurityGroup',
    'DatabaseSecurityGroup', 'DatabaseSubnetGroup', 'Database', 'Cluster', 'LogGroup',
    'DuffelTokenSecret', 'LiteApiKeySecret', 'DuffelTokenSecretPolicy', 'LiteApiKeySecretPolicy',
    'ExecutionRole', 'TaskRole', 'TaskDefinition',
    'AdminExecutionRole', 'AdminTaskDefinition', 'LoadBalancer', 'TargetGroup', 'HttpListener', 'HttpsListener', 'Service',
  ]);
  assert.ok(resource('Service').includes('      TaskDefinition: !Ref TaskDefinition'), 'the service still runs the site task definition');
  assert.equal((app.match(/AdminTaskDefinition/g) || []).length, 1, 'nothing refers to the admin task: no service runs it');
  assert.equal((app.match(/AdminExecutionRole/g) || []).length, 2, 'the role is used by the admin task only');
});

// ---------- infra/www-stack-policy.json ----------

test('the stack policy denies replacing or removing the database and the two supplier keys, and allows every other update', () => {
  const policy = JSON.parse(policyText);
  assert.deepEqual(Object.keys(policy), ['Statement']);
  assert.deepEqual(policy.Statement, [
    {
      Effect: 'Deny', Action: ['Update:Replace', 'Update:Delete'], Principal: '*',
      Resource: ['LogicalResourceId/Database', 'LogicalResourceId/DuffelTokenSecret', 'LogicalResourceId/LiteApiKeySecret'],
    },
    { Effect: 'Allow', Action: 'Update:*', Principal: '*', Resource: '*' },
  ]);
  // The logical id it protects is the RDS instance, and in-place changes (Update:Modify) stay allowed, so
  // the ProtectDatabase change and later minor changes still deploy.
  assert.equal(typeOf('Database'), 'AWS::RDS::DBInstance');
  for (const { id } of SUPPLIER_SECRETS) assert.equal(typeOf(id), 'AWS::SecretsManager::Secret', 'each logical id it names is a resource of the stack');
  for (const s of policy.Statement.filter(x => x.Effect === 'Deny')) {
    assert.ok(![].concat(s.Action).some(a => a === 'Update:*' || a === 'Update:Modify'));
  }
  // The deploy role cannot change it: no workflow step sets or overrides a stack policy.
  assert.doesNotMatch(workflow, /stack-policy|set-stack-policy|SetStackPolicy/i);
});

test('the README says how the policy is applied, how a deliberate migration overrides it, and how to run the admin task', () => {
  assert.match(readme, /aws cloudformation set-stack-policy --region us-east-1 --stack-name tripelyx-staging \\\n\s+--stack-policy-body file:\/\/infra\/www-stack-policy\.json/);
  assert.match(readme, /--stack-policy-during-update-body '\{"Statement":\[\{"Effect":"Allow","Action":"Update:\*","Principal":"\*","Resource":"\*"\}\]\}'/);
  assert.match(readme, /owner's\s+approval/);
  assert.match(readme, /aws ecs run-task --region us-east-1 --cluster tripelyx-staging --task-definition tripelyx-staging-admin/);
  assert.match(readme, /"containerOverrides":\[\{"name":"admin","command":\["node","scripts\/platform-admin\.js","list"\]\}\]/);
  assert.doesNotMatch(readme, /"containerOverrides":\[\{"name":"web"/, 'one-off tasks never run on the site task definition');
  assert.match(readme, /\*\*Dark deploy\.\*\*/);
  assert.match(readme, /\*\*The flip\.\*\*/);
  assert.match(readme, /\*\*Undo\.\*\* Set `ENABLE_BUSINESS` to `false` and run the deploy again/);
  assert.match(readme, /\*\*Never undo with a git revert\.\*\*/);
  assert.match(readme, /\*\*www\.tripelyx\.com is the `tripelyx-staging` stack\*\*/);
  // The policy goes on before the merge, so the dark deploy (the first update CloudFormation ever makes
  // to the database) already runs under it.
  const steps = ['**Stack policy first.**', '**Dark deploy.**', '**The flip.**', '**Undo.**', '**Never undo with a git revert.**'];
  const at = steps.map(x => readme.indexOf(x));
  assert.ok(at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1])), 'the runbook steps, in this order');
  assert.match(readme, /1\. \*\*Stack policy first\.\*\* After the change set preview and before the merge, apply the stack policy/);
  assert.match(readme, /applied once after the change set preview and before the merge that brings this\s+code \(so the dark deploy already runs under it\)/);
  assert.doesNotMatch(readme, /after the dark deploy[^.]*stack policy|stack policy[^.]*after the dark deploy|applied once after the dark deploy/i);
  // ADMIN_EMAILS belongs in a secret.
  assert.match(readme, /`ADMIN_EMAILS`: a repository \*\*secret\*\*, never a variable\./);
  assert.match(readme, /A variable of that name must never hold real addresses\./);
});

test('the README says how to paste a supplier key without it ever showing, how to restart, and how to undo', () => {
  const part = readme.slice(readme.indexOf('#### Pasting a supplier key (Business live search)'), readme.indexOf('#### One-off admin tasks'));
  assert.ok(part.length > 200, 'the section is there, before the admin tasks');
  const flat = part.replace(/\s+/g, ' ');
  for (const name of ['tripelyx-staging/business/duffel-token', 'tripelyx-staging/business/liteapi-key']) assert.ok(part.includes(`\`${name}\``), name);
  assert.match(flat, /The site reads exactly `unset` as not set/);
  assert.match(flat, /"DUFFEL_ACCESS_TOKEN is not set\."/);
  assert.match(flat, /a `duffel_test_` token or a `sand_` key is refused, never shown as test data/);
  // The key is read without echo and never lands in the shell history or the output.
  assert.match(part, /read -rs KEY && aws secretsmanager put-secret-value --region us-east-1 \\\n\s+--secret-id tripelyx-staging\/business\/duffel-token --secret-string "\$KEY" --query VersionId --output text; unset KEY/);
  assert.match(part, /aws ecs update-service --region us-east-1 --cluster tripelyx-staging --service web --force-new-deployment/);
  assert.match(flat, /owner's approval/);
  assert.match(flat, /Nobody runs `get-secret-value` on these/);
  assert.equal((part.match(/get-secret-value/g) || []).length, 1, 'named once, to say nobody runs it');
  assert.match(flat, /\*\*Undo:\*\* paste `unset` back the same way/);
  assert.match(flat, /\*\*Retrieve secret value\*\* in the console says access is denied\. That is expected\./);
  assert.doesNotMatch(part, /\u2014|duffel_(live|test)_[A-Za-z0-9]|sand_[0-9a-f]{4}/, 'no em dash, no key-shaped example');
  assert.match(readme, /on the\s+`Database` resource and on the two supplier key secrets \(`DuffelTokenSecret`, `LiteApiKeySecret`\)/);
});

test('the README says to delete a stack only when its very first creation failed, never the www stack after a failed update', () => {
  // www.tripelyx.com is tripelyx-staging: a reader handling a failed deploy of new code there must not delete it.
  const para = readme.slice(readme.indexOf('Staging runs demo inventory'), readme.indexOf('#### Repository settings the deploy reads')).replace(/\s+/g, ' ');
  assert.ok(para.length > 1);
  assert.match(para, /If the very first creation of a stack fails \(its status is `ROLLBACK_COMPLETE` or `ROLLBACK_FAILED` and it never reached `CREATE_COMPLETE`\), delete that stack in CloudFormation before running the deploy again/);
  assert.match(para, /This never applies to the existing www stack: a failed update there rolls itself back \(`UPDATE_ROLLBACK_COMPLETE`\) and the next deploy simply runs again\./);
  const sentences = code(readme).replace(/\s+/g, ' ').split(/(?<=\.) /);
  assert.deepEqual(sentences.filter(s => /\bdelete\b/i.test(s) && /tripelyx-staging/.test(s)), [], 'no sentence tells the reader to delete the www stack');
});

test('the platform-admin script tells operators to use the admin task definition, never the site\'s', () => {
  const source = read('scripts/platform-admin.js');
  const usage = source.slice(0, source.indexOf("require('../server/config')"));
  assert.doesNotMatch(usage, /"name":"web"|app's task definition|<app task definition>/);
  assert.match(usage, /--task-definition tripelyx-<env>-admin /);
  assert.match(usage, /'\{"containerOverrides":\[\{"name":"admin","command":\["node","scripts\/platform-admin\.js","list"\]\}\]\}'/);
  assert.match(usage, /"One-off admin tasks" in README\.md/);
  assert.match(readme, /^#### One-off admin tasks$/m, 'the section it points at');
});

// ---------- .github/workflows/deploy.yml ----------

test('the deploy keeps the staging default, Business off by default, and the AdminEmails source', () => {
  assert.match(workflow, /\n {2}APP_ENV: \$\{\{ vars\.APP_ENV \|\| 'staging' \}\}\n/, 'www is the staging stack');
  assert.match(workflow, /group: deploy-\$\{\{ vars\.APP_ENV \|\| 'staging' \}\}\n/);
  assert.match(workflow, /--stack-name "tripelyx-\$\{APP_ENV\}" \\\n/);
  // ENABLE_BUSINESS is read in one place: the switch step, with 'false' when unset.
  assert.deepEqual([...workflow.matchAll(/vars\.ENABLE_BUSINESS[^}]*\}\}/g)].map(m => m[0]), ["vars.ENABLE_BUSINESS || 'false' }}"]);
  const deploy = step('Deploy the stack').lines.join('\n');
  assert.match(deploy, /\n {10}ADMIN_EMAILS: \$\{\{ secrets\.ADMIN_EMAILS \|\| vars\.ADMIN_EMAILS \}\}\n/);
  assert.match(deploy, /\n {10}ENABLE_BUSINESS: \$\{\{ steps\.switches\.outputs\.enable_business \}\}\n/);
  assert.match(deploy, /\n {14}AdminEmails="\$\{ADMIN_EMAILS\}" \\\n/);
  assert.match(deploy, /\n {14}EnableBusiness="\$\{ENABLE_BUSINESS\}" \\\n/);
  assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))], ['ADMIN_EMAILS'], 'the only secret the deploy reads');
  // The variable is read twice: into the guard, where it becomes the text true or false, and into the
  // deploy step's env (which the guard has stopped whenever only the variable is set). Never into a script.
  assert.deepEqual([...workflow.matchAll(/^.*vars\.ADMIN_EMAILS.*$/gm)].map(m => m[0].trim()), [
    "ADMIN_EMAILS_ONLY_IN_VARIABLE: ${{ secrets.ADMIN_EMAILS == '' && vars.ADMIN_EMAILS != '' }}",
    'ADMIN_EMAILS: ${{ secrets.ADMIN_EMAILS || vars.ADMIN_EMAILS }}',
  ]);
  assert.deepEqual([...workflow.matchAll(/\$\{\{[^}]*ADMIN_EMAILS[^}]*\}\}/g)].length, 2, 'nowhere else');
  // The parameters a deploy sets. AllowDemoInventory, PaymentMode, EnableTrips and ProtectDatabase are not
  // passed, so the stack keeps its own values: demo inventory for /book, test payments, the database protected.
  const overrides = deploy.slice(deploy.indexOf('--parameter-overrides'));
  assert.deepEqual([...overrides.matchAll(/^\s+([A-Za-z]+)=/gm)].map(m => m[1]), ['AppEnv', 'ImageUri', 'CertificateArn', 'AdminEmails', 'EnableBusiness', 'PublicBaseUrl']);
  assert.equal(paramDefault('ProtectDatabase'), 'true');
});

test('only the deploy job can get an OIDC token for the deploy role; the test job (npm ci, npm test) cannot', () => {
  // A token from the test job would carry the same subject (this repo's main) that tripelyx-github-deploy trusts.
  assert.deepEqual(block(workflow, 'permissions', 0), ['permissions:', '  contents: read'], 'the workflow default is read-only');
  const jobs = block(workflow, 'jobs', 0);
  const job = name => {
    const at = jobs.indexOf(`  ${name}:`);
    assert.ok(at >= 0, `the ${name} job is there`);
    const out = [];
    for (const l of jobs.slice(at + 1)) {
      if (/^ {2}\S/.test(l)) break;
      out.push(l);
    }
    return out;
  };
  assert.deepEqual(jobs.filter(l => /^ {2}\S/.test(l)).map(l => l.trim()), ['test:', 'deploy:']);
  const deploy = job('deploy');
  const at = deploy.indexOf('    permissions:');
  assert.ok(at >= 0, 'the deploy job sets its own permissions');
  assert.deepEqual(deploy.slice(at, at + 3), ['    permissions:', '      id-token: write', '      contents: read']);
  assert.ok(!/^ {6}\S/.test(deploy[at + 3] || ''), 'and nothing more');
  assert.ok(deploy.indexOf('    needs: test') >= 0 && deploy.indexOf('    needs: test') < at && at < deploy.indexOf('    steps:'));
  assert.doesNotMatch(job('test').join('\n'), /permissions|id-token/, 'the test job keeps the read-only default');
  assert.equal((code(workflow).match(/id-token/g) || []).length, 1, 'id-token: write is granted once, to the deploy job');
  assert.doesNotMatch(code(workflow), /write-all|permissions: write/);
  assert.doesNotMatch(code(workflow), /^ {4}environment:/m, 'no GitHub environment (it would change the OIDC subject)');
});

test('the switch step comes first, before the build and before any AWS sign-in', () => {
  const names = deploySteps().map(s => s.name);
  assert.deepEqual(names, [
    'Check the switches', 'actions/checkout@v4', 'aws-actions/configure-aws-credentials@v4', 'aws-actions/amazon-ecr-login@v2',
    'Build and push the image', 'Page hashes before the deploy', 'Deploy the stack', 'Show the site address',
    'Page hashes after the deploy, and checks',
  ]);
  const s = step('Check the switches').lines.join('\n');
  assert.match(s, /\n {8}id: switches\n/);
  const env = s.slice(s.indexOf('\n        env:\n'), s.indexOf('\n        run: |\n'));
  assert.deepEqual(code(env).split('\n').filter(Boolean), [
    '        env:',
    "          ENABLE_BUSINESS: ${{ vars.ENABLE_BUSINESS || 'false' }}",
    "          ADMIN_EMAILS_ONLY_IN_VARIABLE: ${{ secrets.ADMIN_EMAILS == '' && vars.ADMIN_EMAILS != '' }}",
  ], 'the guard is an expression that evaluates to true or false, so the address never reaches the run log');
  assert.match(s, /\n {10}normalise ENABLE_BUSINESS false 'true or false' true false\n/);
  assert.match(s, /\n {10}if \[ "\$ADMIN_EMAILS_ONLY_IN_VARIABLE" = true \]; then\n/);
});

test('the switch step trims and lowercases ENABLE_BUSINESS, defaults to false, and stops on anything else, naming the variable', { skip: !hasBash && 'bash is not installed' }, async () => {
  const script = runScript(step('Check the switches'));
  const dir = tmp();
  const file = path.join(dir, 'switches.sh');
  fs.writeFileSync(file, script);
  const ok = [['', 'false'], [' ', 'false'], ['\n', 'false'], ['false', 'false'], ['true', 'true'], [' True ', 'true'], ['TRUE', 'true'],
    ['FALSE\n', 'false'], ['\ttrue\r\n', 'true'], ['  fAlSe', 'false']];
  for (const [i, [value, want]] of ok.entries()) {
    const out = path.join(dir, `out-${i}`);
    fs.writeFileSync(out, '');
    const r = await run('bash', ['-e', file], shellEnv({ ENABLE_BUSINESS: value, GITHUB_OUTPUT: out }));
    assert.equal(r.code, 0, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.readFileSync(out, 'utf8'), `enable_business=${want}\n`, JSON.stringify(value));
    assert.equal(r.stdout, `ENABLE_BUSINESS is ${want}.\n`);
  }
  for (const [i, value] of ['yes', 'on', '1', 'enabled-xyz', 'tru e', 'true false', 'true\nfalse', "'true'", '"true"', 'true;', '$(echo true)', 'live'].entries()) {
    const out = path.join(dir, `bad-${i}`);
    fs.writeFileSync(out, '');
    const r = await run('bash', ['-e', file], shellEnv({ ENABLE_BUSINESS: value, GITHUB_OUTPUT: out }));
    assert.equal(r.code, 1, JSON.stringify(value));
    assert.equal(r.stdout, '::error title=ENABLE_BUSINESS::ENABLE_BUSINESS must be true or false (lowercase). Change the repository variable ENABLE_BUSINESS (Settings, Secrets and variables, Actions, Variables), then run the deploy again.\n');
    assert.equal(fs.readFileSync(out, 'utf8'), '', 'nothing passed on');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the switch step stops the run when ADMIN_EMAILS is only a variable, which would print in clear', { skip: !hasBash && 'bash is not installed' }, async () => {
  const script = runScript(step('Check the switches'));
  const dir = tmp();
  const file = path.join(dir, 'switches.sh');
  fs.writeFileSync(file, script);
  // GitHub hands the step the guard's value: the text true or false (or nothing, run by hand).
  for (const [i, guard] of ['false', '', undefined].entries()) {
    const out = path.join(dir, `ok-${i}`);
    fs.writeFileSync(out, '');
    const env = { ENABLE_BUSINESS: 'false', GITHUB_OUTPUT: out };
    if (guard !== undefined) env.ADMIN_EMAILS_ONLY_IN_VARIABLE = guard;
    const r = await run('bash', ['-e', file], shellEnv(env));
    assert.equal(r.code, 0, `${JSON.stringify(guard)}: ${r.stdout}`);
    assert.equal(r.stdout, 'ENABLE_BUSINESS is false.\n');
  }
  const out = path.join(dir, 'variable-only');
  fs.writeFileSync(out, '');
  const r = await run('bash', ['-e', file], shellEnv({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS_ONLY_IN_VARIABLE: 'true', ADMIN_EMAILS: 'owner@example.com', GITHUB_OUTPUT: out }));
  assert.equal(r.code, 1, 'red, before the build and before any step prints the address');
  assert.equal(r.stdout, 'ENABLE_BUSINESS is true.\n::error title=ADMIN_EMAILS::ADMIN_EMAILS is set as a repository variable, which prints in the public run log. Move it to a repository secret of that name (Settings, Secrets and variables, Actions, Secrets), delete the variable, then run the deploy again.\n');
  assert.doesNotMatch(r.stdout + r.stderr, /owner@example\.com/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The image step, run under bash (with -e, as GitHub runs it) with a stand-in docker.
function imageStep(t) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$DOCKER_LOG"',
    'if [ "$1" = "$FAIL_ON" ]; then echo "$1 failed" >&2; exit 1; fi',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  // ECR as the deploy role sees it: IMAGE_IN_ECR yes (found), no (ImageNotFoundException) or denied.
  fs.writeFileSync(path.join(bin, 'aws'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$AWS_LOG"',
    'case "$IMAGE_IN_ECR" in',
    '  yes) echo \'{"imageDetails":[{"imageTags":["x"]}]}\'; exit 0 ;;',
    '  no) echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation: The image with imageId {imageTag:\'$GITHUB_SHA\'} does not exist" >&2; exit 254 ;;',
    '  *) echo "An error occurred (AccessDeniedException) when calling the DescribeImages operation: not authorized" >&2; exit 254 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  const file = path.join(dir, 'image.sh');
  fs.writeFileSync(file, runScript(step('Build and push the image')));
  return async env => {
    const output = path.join(dir, 'output'), log = path.join(dir, 'docker.log'), awsLog = path.join(dir, 'aws.log');
    fs.writeFileSync(output, '');
    fs.writeFileSync(log, '');
    fs.writeFileSync(awsLog, '');
    const r = await run('bash', ['-e', file], shellEnv({
      PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, DOCKER_LOG: log, AWS_LOG: awsLog, IMAGE: IMG, GITHUB_SHA: SHA, IMAGE_IN_ECR: 'no', FAIL_ON: '', ...env,
    }));
    const lines = f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    return { ...r, output: fs.readFileSync(output, 'utf8'), docker: lines(log), aws: lines(awsLog) };
  };
}
const SHA = '0123456789abcdef0123456789abcdef01234567';
const IMG = `123456789012.dkr.ecr.us-east-1.amazonaws.com/tripelyx:${SHA}`;
const DESCRIBE = `ecr describe-images --repository-name tripelyx --image-ids imageTag=${SHA}`;

test('the image step: a first run builds and pushes; a second run on the same commit (flip, undo, re-run) reuses the image', { skip: !hasBash && 'bash is not installed' }, async t => {
  const s = step('Build and push the image').lines.join('\n');
  assert.match(s, /\n {10}IMAGE: \$\{\{ steps\.ecr\.outputs\.registry \}\}\/tripelyx:\$\{\{ github\.sha \}\}\n/, 'one tag per commit');
  assert.match(read('infra/bootstrap.yaml'), /\n {6}ImageTagMutability: IMMUTABLE\n/, 'why: the repository refuses a second push of a tag');
  assert.match(read('infra/bootstrap.yaml'), /- ecr:DescribeImages\n/, 'the deploy role can ask ECR which tags exist');
  assert.doesNotMatch(read('infra/bootstrap.yaml'), /ecr:GetDownloadUrlForLayer/, 'why not docker manifest inspect: it downloads the image config, a pull right the deploy role lacks');
  assert.doesNotMatch(s, /manifest inspect/);
  const image = imageStep(t);

  let r = await image({ IMAGE_IN_ECR: 'no' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.aws, [DESCRIBE]);
  assert.deepEqual(r.docker, [`build -t ${IMG} .`, `push ${IMG}`]);
  assert.equal(r.stdout, '', 'the not-found message is not printed');
  assert.equal(r.output, `uri=${IMG}\n`);

  r = await image({ IMAGE_IN_ECR: 'yes' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.aws, [DESCRIBE]);
  assert.deepEqual(r.docker, [], 'no rebuild and no push of a tag that already exists');
  assert.equal(r.stdout, 'The image for this commit is already in ECR; reusing it.\n', 'the image details are not printed');
  assert.equal(r.output, `uri=${IMG}\n`, 'the same ImageUri, so only the environment changes');

  // 10-09: a check the role could not complete read as "no image", rebuilt, and the push was refused.
  r = await image({ IMAGE_IN_ECR: 'denied' });
  assert.notEqual(r.code, 0, 'a check that cannot answer stops the run');
  assert.deepEqual(r.docker, [], 'nothing built or pushed');
  assert.equal(r.output, '', 'no image passed on');
  assert.match(r.stdout, /^::error title=Image check::Could not tell whether this commit's image is already in ECR, so nothing was built or pushed\./);
  assert.match(r.stderr, /AccessDeniedException/, 'the AWS error is shown');

  for (const failOn of ['build', 'push']) {
    r = await image({ IMAGE_IN_ECR: 'no', FAIL_ON: failOn });
    assert.notEqual(r.code, 0, `a failed ${failOn} stops the run`);
    assert.equal(r.output, '', 'no image passed on');
  }
});

test('the page check reads the stack URL, calls no AWS write, and the deploy job changes nothing but the stack it deploys', () => {
  const script = pageCheckScript();
  assert.match(script, /url=\$\(aws cloudformation describe-stacks --stack-name "tripelyx-\$\{APP_ENV\}" \\\n\s+--query "Stacks\[0\]\.Outputs\[\?OutputKey=='SiteUrl'\]\.OutputValue" --output text 2>\/dev\/null\)/);
  assert.match(script, /for p in \/ \/book \/ai-travel-agent; do/);
  assert.match(script, /sed -E 's\/\\\?v=\[0-9a-z\]\+\/\/g'/, 'the ?v= asset versions are removed before hashing');
  assert.doesNotMatch(workflow, /elb\.amazonaws\.com|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no load balancer address or IP is written down');
  const calls = [...code(workflow).matchAll(/\baws ([a-z0-9-]+) ([a-z0-9-]+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual([...new Set(calls)].sort(), ['cloudformation deploy', 'cloudformation describe-stacks', 'ecr describe-images', 'sts get-caller-identity']);
  assert.match(step('Page hashes after the deploy, and checks').lines.join('\n'), /\n {8}run: bash "\$RUNNER_TEMP\/page-check\.sh" after\n?$/);
  assert.doesNotMatch(code(workflow), /continue-on-error|if: always\(\)|rollback|revert|delete-stack|cancel-update/i, 'it reports and never undoes');
  assert.doesNotMatch(code(workflow), /set -x|printenv|toJSON\(secrets\)|cat "\$body"|cat \$body/);
});

// The page check, run for real against a small local server, with a stand-in for `aws` that answers the
// stack's SiteUrl output (and records what it was asked).
async function pageServer(t, pages) {
  const server = http.createServer((req, res) => {
    const page = pages[req.url];
    if (!page) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<p>Not found PAGE-TEXT-MARKER</p>'); }
    res.writeHead(page[0], { 'content-type': 'text/html' });
    res.end(page[1]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

function pageCheck(t) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), '#!/usr/bin/env bash\necho "$*" >> "$AWS_LOG"\nif [ -n "${AWS_SITE_URL:-}" ]; then echo "$AWS_SITE_URL"; else echo "Stack does not exist" >&2; exit 254; fi\n', { mode: 0o755 });
  const script = path.join(dir, 'page-check.sh');
  fs.writeFileSync(script, pageCheckScript());
  const summary = path.join(dir, 'summary.md');
  const awsLog = path.join(dir, 'aws.log');
  return {
    dir, bin, summary, awsLog,
    run: (phase, env) => run('bash', [script, phase], shellEnv({
      PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, AWS_LOG: awsLog,
      APP_ENV: 'staging', PUBLIC_BASE_URL: 'https://www.tripelyx.com', ENABLE_BUSINESS: 'false', ...env,
    })),
  };
}

const LINE = /^(?:(\/[a-z/-]*): (\d{3}) sha256 ([0-9a-f]{64})(?:, (same|changed|no hash from before))?|\/healthz: \d{3}|Business is off: no Business page checked\.|No SiteUrl output to read \(no stack yet\?\): nothing to compare\.|::(?:error|warning) title=[A-Za-z ]+::.*)$/;
function lines(out) {
  const all = out.split('\n').filter(Boolean);
  for (const l of all) assert.match(l, LINE, 'only status codes, hashes and notes are printed');
  assert.doesNotMatch(out, /PAGE-TEXT-MARKER|127\.0\.0\.1|<p>|<html/);
  return all;
}

const page = (marker, v = 'abc12') => `<!doctype html><link href="/css/site.css?v=${v}"><p>${marker} PAGE-TEXT-MARKER</p><script src="/js/site.js?v=${v}"></script>`;
const sha = text => sha256(text.replace(/\?v=[0-9a-z]+/g, ''));

test('the page check: hashes before and after, "same" despite a new ?v=, "changed", and red only on /healthz', { skip: (!hasBash || !hasCurl) && 'bash or curl is not installed' }, async t => {
  const pages = { '/': [200, page('home')], '/book': [200, page('book')], '/ai-travel-agent': [200, page('agent')], '/healthz': [200, '{"ok":true}'] };
  const url = await pageServer(t, pages);
  const pc = pageCheck(t);

  let r = await pc.run('before', { AWS_SITE_URL: url });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [`/: 200 sha256 ${sha(page('home'))}`, `/book: 200 sha256 ${sha(page('book'))}`, `/ai-travel-agent: 200 sha256 ${sha(page('agent'))}`]);
  assert.equal(r.stderr, '');

  // A new boot: every ?v= differs. /book really changed and now fails; /ai-travel-agent is gone. Report
  // only, but a status regression gets a warning of its own, so it never reads like a harmless "changed".
  pages['/'] = [200, page('home', 'zz9x1')];
  pages['/book'] = [500, page('book has changed', 'zz9x1')];
  delete pages['/ai-travel-agent'];
  r = await pc.run('after', { AWS_SITE_URL: url });
  assert.equal(r.code, 0, `report only: ${r.stdout}`);
  const notFound = '<p>Not found PAGE-TEXT-MARKER</p>';
  assert.deepEqual(lines(r.stdout), [
    `/: 200 sha256 ${sha(page('home'))}, same`,
    `/book: 500 sha256 ${sha(page('book has changed'))}, changed`,
    '::warning title=Page status::/book answered 500, before the deploy 200.',
    `/ai-travel-agent: 404 sha256 ${sha256(notFound)}, changed`,
    '::warning title=Page status::/ai-travel-agent answered 404, before the deploy 200.',
    '/healthz: 200',
    'Business is off: no Business page checked.',
  ]);
  const summary = fs.readFileSync(pc.summary, 'utf8');
  assert.match(summary, /^### Pages before the deploy\n- \/: 200 sha256 [0-9a-f]{64}\n/);
  assert.match(summary, /### Pages after the deploy\n- \/: 200 sha256 [0-9a-f]{64}, same\n/);
  assert.match(summary, /\n- \/book: 500 sha256 [0-9a-f]{64}, changed\n- Warning: \/book answered 500, before the deploy 200\.\n/, 'next to the hash in the run summary');
  assert.doesNotMatch(summary, /PAGE-TEXT-MARKER|127\.0\.0\.1/);

  pages['/healthz'] = [503, 'down'];
  r = await pc.run('after', { AWS_SITE_URL: url });
  assert.equal(r.code, 1, 'red: /healthz is not 200');
  assert.ok(lines(r.stdout).includes('::error title=Health check::/healthz answered 503, not 200.'));

  // The flip: all three pages change (the Business header item) but answer 200 as before: no warning.
  // A page that was failing before and answers 200 now is noted too (the status is not the one from before).
  Object.assign(pages, { '/healthz': [200, '{"ok":true}'], '/': [200, page('home with Business')], '/book': [200, page('book with Business')], '/ai-travel-agent': [200, page('agent with Business')] });
  r = await pc.run('after', { AWS_SITE_URL: url });
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.stdout).slice(0, 3).map(l => l.replace(/ sha256 [0-9a-f]{64}/, '')), ['/: 200, changed', '/book: 200, changed', '/ai-travel-agent: 200, changed']);
  assert.doesNotMatch(r.stdout, /::warning/);
  fs.writeFileSync(path.join(pc.dir, 'page-hashes-before.txt'), `/ 000 ${'0'.repeat(64)}\n/book 503 ${'0'.repeat(64)}\n`);
  r = await pc.run('after', { AWS_SITE_URL: url });
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.stdout).filter(l => l.startsWith('::')), [
    '::warning title=Page status::/ answered 200, before the deploy 000.',
    '::warning title=Page status::/book answered 200, before the deploy 503.',
  ], 'no hash from before and 200 now: nothing to compare, no warning');
  // No hash from before and not 200 now.
  delete pages['/ai-travel-agent'];
  r = await pc.run('after', { AWS_SITE_URL: url });
  assert.ok(lines(r.stdout).includes('::warning title=Page status::/ai-travel-agent answered 404, before the deploy unknown.'));

  // Only the stack's output is asked for; nothing else is called.
  const asked = fs.readFileSync(pc.awsLog, 'utf8').trim().split('\n');
  assert.equal(asked.length, 6);
  for (const a of asked) assert.equal(a, "cloudformation describe-stacks --stack-name tripelyx-staging --query Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue --output text");
});

test('the page check with Business on: red on demo wording or the environment banner on a Business page, a warning on an odd status', { skip: (!hasBash || !hasCurl) && 'bash or curl is not installed' }, async t => {
  const clean = { '/': [200, page('home')], '/book': [200, page('book')], '/ai-travel-agent': [200, page('agent')], '/healthz': [200, '{"ok":true}'], '/business': [200, page('Company travel')] };
  const pages = { ...clean };
  const url = await pageServer(t, pages);
  const pc = pageCheck(t);
  assert.equal((await pc.run('before', { AWS_SITE_URL: url })).code, 0);

  let r = await pc.run('after', { AWS_SITE_URL: url, ENABLE_BUSINESS: 'true' });
  assert.equal(r.code, 0, r.stdout);
  const out = lines(r.stdout);
  assert.deepEqual(out.slice(3).map(l => l.replace(/ sha256 [0-9a-f]{64}/, '')), ['/healthz: 200', '/business: 200', '/business/no-such-page: 404']);

  for (const [p, body] of [['/business', page('Demo price')], ['/business', page('This is demo data')], ['/business', page('<span data-price-source="demo">')],
    ['/business', page('Searches run on demo inventory')],
    ['/business/no-such-page', '<aside class="env-banner" aria-label="Environment notice">Staging build · demo inventory · payments in test mode</aside>']]) {
    pages[p] = [p === '/business' ? 200 : 404, body];
    r = await pc.run('after', { AWS_SITE_URL: url, ENABLE_BUSINESS: 'true' });
    assert.equal(r.code, 1, `red: ${body}`);
    assert.ok(lines(r.stdout).includes(`::error title=Demo wording::${p} shows demo wording or the environment banner.`));
    Object.assign(pages, clean);
    delete pages['/business/no-such-page'];
  }

  pages['/business'] = [500, page('Something went wrong')];
  r = await pc.run('after', { AWS_SITE_URL: url, ENABLE_BUSINESS: 'true' });
  assert.equal(r.code, 0, 'a status other than the expected one is a warning only');
  assert.ok(lines(r.stdout).includes('::warning title=Business page::/business answered 500, expected 200.'));
});

test('the page check with no stack: before notes it and carries on, after is red because /healthz was not checked', { skip: !hasBash && 'bash is not installed' }, async t => {
  const pc = pageCheck(t);
  let r = await pc.run('before', {});
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.stdout), ['No SiteUrl output to read (no stack yet?): nothing to compare.']);
  r = await pc.run('after', {});
  assert.equal(r.code, 1);
  assert.deepEqual(lines(r.stdout), ["::error title=Health check::The stack's SiteUrl output could not be read, so /healthz was not checked."]);
});

test('the page check over HTTPS asks for the site by name, connected to this stack\'s load balancer from SiteUrl', { skip: !hasBash && 'bash is not installed' }, async t => {
  const pc = pageCheck(t);
  const curlLog = path.join(pc.dir, 'curl.log');
  // A stand-in curl: records its arguments, writes a page to -o and answers 200.
  fs.writeFileSync(path.join(pc.bin, 'curl'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$CURL_LOG"',
    'out=""; prev=""',
    'for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done',
    'echo "<p>page</p>" > "$out"',
    'printf 200',
  ].join('\n') + '\n', { mode: 0o755 });
  const lb = 'tripelyx-loadb-0123456789.us-east-1.elb.amazonaws.com';
  const r = await pc.run('after', { AWS_SITE_URL: `https://${lb}`, CURL_LOG: curlLog, ENABLE_BUSINESS: 'true' });
  assert.equal(r.code, 0, r.stdout);
  const calls = fs.readFileSync(curlLog, 'utf8').trim().split('\n');
  assert.deepEqual(calls.map(c => c.split(' ').slice(-1)[0]), ['/', '/book', '/ai-travel-agent', '/healthz', '/business', '/business/no-such-page'].map(p => `https://www.tripelyx.com${p}`));
  for (const c of calls) assert.ok(c.includes(`--connect-to www.tripelyx.com:443:${lb}:443 `), c);
  for (const c of calls) assert.doesNotMatch(c, /(^|\s)(-k|--insecure|-L|--location)(\s|$)/, 'TLS is checked and redirects are not followed');
});

// ---------- What the www container's environment serves ----------

/** The www container's environment as a deploy sets it: parameters from deploy.yml or the stack's kept values (their defaults). */
function wwwEnvironment({ enableBusiness }) {
  const values = {
    AppEnv: 'staging', AdminEmails: '', EnableBusiness: enableBusiness, PublicBaseUrl: 'https://www.tripelyx.com',
    // Not passed by deploy.yml: the stack keeps its values, which are these defaults on tripelyx-staging.
    AllowDemoInventory: paramDefault('AllowDemoInventory'), PaymentMode: paramDefault('PaymentMode'), EnableTrips: paramDefault('EnableTrips'),
  };
  const env = {};
  for (const [name, raw] of pairs(containers('TaskDefinition')[0].lines, 'Environment')) {
    let m;
    if ((m = /^'(.*)'$/.exec(raw))) env[name] = m[1];
    else if ((m = /^!Ref (\w+)$/.exec(raw))) { assert.ok(m[1] in values, `${name}: ${m[1]}`); env[name] = values[m[1]]; }
    else if (raw === "!If [HasCertificate, 'true', 'false']") env[name] = 'true';
    else if (/^!GetAtt Database\./.test(raw)) continue;
    else env[name] = raw;
  }
  // The supplier keys hold what the stack creates them with until the owner pastes a key: the placeholder.
  for (const [name, raw] of pairs(containers('TaskDefinition')[0].lines, 'Secrets')) {
    const m = /^!Ref (\w+)$/.exec(raw);
    if (!m) continue;
    const value = resource(m[1]).find(l => /^ {6}SecretString: /.test(l)).trim().slice('SecretString: '.length);
    env[name] = value;
  }
  assert.equal(env.DUFFEL_ACCESS_TOKEN, 'unset');
  assert.equal(env.LITEAPI_API_KEY, 'unset');
  // The database parts need the password secret; the pages are the same on the in-memory store.
  for (const k of Object.keys(env)) if (/^DATABASE_/.test(k) && k !== 'DATABASE_ENV') delete env[k];
  return { ...env, DATABASE_URL: 'memory' };
}

async function wwwPages(t, env) {
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  const site = await bootApp(ROOT, env);
  t.after(site.close);
  const got = {};
  for (const p of ['/', '/book', '/ai-travel-agent']) {
    const res = await fetch(site.base + p, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }, redirect: 'manual' });
    got[p] = { status: res.status, text: normalise(await res.text()) };
  }
  return { site, got };
}

const live = manifest.envs.live;
const WANT = { '/': live.pages['/'], '/ai-travel-agent': live.pages['/ai-travel-agent'], '/book': live.full.book };

test('the www environment from app.yaml leaves /, /book and /ai-travel-agent exactly as they were (the dark deploy)', async t => {
  const env = wwwEnvironment({ enableBusiness: 'false' });
  assert.equal(env.BUSINESS_DEMO_INVENTORY, 'false');
  assert.equal(env.ALLOW_DEMO_INVENTORY, 'true');
  assert.equal(env.APP_ENV, 'staging');
  const { site, got } = await wwwPages(t, env);
  assert.equal(site.ctx.business, null, 'Business is off on the first deploy');
  for (const [p, want] of Object.entries(WANT)) {
    assert.equal(got[p].status, want.status, p);
    assert.equal(sha256(got[p].text), want.sha256, `${p} is byte for byte the page www serves today`);
  }
  assert.match(got['/book'].text, /Demo inventory|demo/i, '/book still runs on its demo inventory');
});

test('with ENABLE_BUSINESS=true (the flip) the same three pages differ only by the Business header item and footer link', async t => {
  const { site, got } = await wwwPages(t, wwwEnvironment({ enableBusiness: 'true' }));
  assert.ok(site.ctx.business, 'Business runs');
  // The supplier keys still hold "unset": Business has no supplier and shows no price at all.
  assert.equal(site.ctx.business.inventory.status, 'none');
  assert.equal(site.ctx.business.inventory.problem, 'DUFFEL_ACCESS_TOKEN is not set.');
  for (const [p, want] of Object.entries(WANT)) {
    const { text, counts } = stripBusiness(got[p].text);
    assert.deepEqual(counts, expectedBusinessCounts(got[p].text), p);
    assert.equal(counts.navItem, 1, `${p}: the Business header item`);
    assert.equal(sha256(text), want.sha256, `${p}: nothing else changed`);
  }
});
