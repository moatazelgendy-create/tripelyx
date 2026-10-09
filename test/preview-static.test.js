// Static checks on the private preview's workflow and stack (.github/workflows/preview.yml, infra/preview.yaml).
// No YAML parser is installed, so these are careful text checks on the lines that matter: which branch runs it,
// which role it uses, what it may touch, and that no secret value is written into either file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/config');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'claude/travel-by-budget-uv85qf';
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const workflow = read('.github/workflows/preview.yml');
const stack = read('infra/preview.yaml');

/** The file without its full-line comments (a `#` inside a string, like "### heading", is kept). */
const code = text => text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

/** The lines of a top-level YAML key's block, without comments. */
function topBlock(text, key) {
  const lines = code(text).split('\n');
  const start = lines.findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
  assert.ok(start >= 0, `top-level ${key}: is there`);
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    if (l.trim()) out.push(l);
  }
  return out;
}

/** The lines of a job under `jobs:` (two-space indent), without comments. */
function jobBlock(name) {
  const lines = topBlock(workflow, 'jobs');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `job ${name} is there`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

test('the workflow runs only on the development branch (push or by hand), never on main', () => {
  assert.deepEqual(topBlock(workflow, 'on'), [
    'on:',
    '  push:',
    `    branches: [${BRANCH}]`,
    '  workflow_dispatch:',
  ]);
  const jobs = topBlock(workflow, 'jobs').filter(l => /^ {2}\S/.test(l)).map(l => l.trim());
  assert.deepEqual(jobs, ['test:', 'preview:']);
  // workflow_dispatch can pick any branch that has this file: each job checks the ref itself.
  for (const job of ['test', 'preview']) {
    assert.ok(jobBlock(job).includes(`    if: github.ref == 'refs/heads/${BRANCH}'`), `${job} only runs on ${BRANCH}`);
  }
  assert.ok(jobBlock('preview').includes('    needs: test'), 'the tests pass first');
  const steps = jobBlock('test').join('\n');
  assert.match(steps, /- run: npm ci\n\s+- run: npm test/);
  const body = code(workflow);
  assert.doesNotMatch(body, /\bmain\b/, 'main is never named outside comments');
  assert.doesNotMatch(body, /pull_request|schedule:|branches-ignore|tags:|workflow_run|repository_dispatch/);
  assert.doesNotMatch(body, /^ {4}environment:/m, 'no GitHub environment (it would change the OIDC subject)');
});

test('the workflow signs in only as the preview role and touches only the preview service, registry and secret', () => {
  const body = code(workflow);
  assert.match(body, /AWS_ROLE_ARN: \$\{\{ vars\.PREVIEW_ROLE_ARN \|\| 'arn:aws:iam::957123506077:role\/tripelyx-github-preview' \}\}/);
  assert.match(body, /role-to-assume: \$\{\{ env\.AWS_ROLE_ARN \}\}/);
  assert.equal((body.match(/role-to-assume:/g) || []).length, 1);
  assert.match(body, /arn:aws:iam::\*:role\/tripelyx-github-preview\) ;;/, 'a run-time check refuses any other role name');
  for (const banned of ['tripelyx-github-deploy', 'tripelyx-cfn-execution', 'vars.AWS_ROLE_ARN', 'vars.AWS_REGION', 'cloudformation',
    'tripelyx-staging', 'tripelyx-production', 'tripelyx-bootstrap', 'infra/app.yaml', 'infra/bootstrap.yaml', 'aws ecs', 'aws rds', 'elbv2', 'route53',
    'CERTIFICATE_ARN', 'update-container-service', 'delete-container']) {
    assert.ok(!body.includes(banned), `the workflow never uses ${banned}`);
  }
  assert.match(body, /SERVICE: tripelyx-preview\n/);
  assert.match(body, /REPOSITORY: tripelyx-preview\n/);
  assert.match(body, /PASSWORD_SECRET: tripelyx-preview\/password\n/);
  // Every AWS CLI call, by service and command.
  const calls = [...body.matchAll(/\baws ([a-z0-9-]+) ([a-z0-9-]+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.ok(calls.length >= 6);
  const allowed = new Set(['lightsail get-container-services', 'lightsail create-container-service-deployment', 'lightsail get-container-service-deployments',
    'lightsail get-container-log', 'ecr describe-images', 'secretsmanager get-secret-value']);
  for (const c of calls) assert.ok(allowed.has(c), `aws ${c} is allowed`);
  assert.deepEqual([...body.matchAll(/permissions:\n((?: {2}.*\n)+)/g)].map(m => m[1]), ['  id-token: write\n  contents: read\n']);
  assert.match(body, /uses: aws-actions\/configure-aws-credentials@v4\n/);
  assert.match(body, /continue-on-error: true\n\s+uses: aws-actions\/configure-aws-credentials@v4/, 'no stack yet: a notice, not a failure');
  assert.match(body, /if: steps\.aws\.outcome != 'success'/);
  assert.match(body, /::notice title=Private preview::/);
});

test('no secret value is written into the workflow, and the password is masked and never printed', () => {
  const body = code(workflow);
  assert.doesNotMatch(workflow, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
  assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))].sort(), ['DUFFEL_TEST_TOKEN', 'LITEAPI_SANDBOX_KEY']);
  // Each place PREVIEW_PASSWORD gets a value reads it from Secrets Manager or the environment.
  const sets = [...body.matchAll(/PREVIEW_PASSWORD(=|: )(.*)/g)].map(m => m[2].trim());
  assert.ok(sets.length >= 2);
  for (const v of sets) assert.ok(/^\$\(aws secretsmanager get-secret-value /.test(v) || /^env\.PREVIEW_PASSWORD,?$/.test(v), `PREVIEW_PASSWORD comes from AWS, not "${v}"`);
  const echoes = body.split('\n').filter(l => /\becho\b|>> "\$GITHUB_STEP_SUMMARY"|::notice|::error/.test(l) && /PREVIEW_PASSWORD/.test(l));
  assert.deepEqual(echoes.map(l => l.trim()), ['echo "::add-mask::${PREVIEW_PASSWORD}"'], 'the only echo of it is the mask');
  assert.ok(body.indexOf('::add-mask::') < body.indexOf('PREVIEW_PASSWORD: env.PREVIEW_PASSWORD'), 'masked before it is used');
  assert.doesNotMatch(body, /set -x|set -o xtrace|--debug|ACTIONS_STEP_DEBUG/);
  assert.match(body, /--query 'containerService\.nextDeployment\.version'/, 'the deployment response (which repeats the settings) is not printed');
  // The summary names the secret, never its value.
  const summary = body.split('\n').filter(l => /GITHUB_STEP_SUMMARY|^\s+echo "/.test(l) && !l.includes('::add-mask::')).join('\n');
  assert.doesNotMatch(summary, /\$\{?PREVIEW_PASSWORD/);
});

test('the deployment settings boot the app with Business on, the memory store, demo inventory and the gate', () => {
  const block = workflow.slice(workflow.indexOf('environment: ({'), workflow.indexOf('PREVIEW_SEED: "business"') + 30);
  const env = Object.fromEntries([...block.matchAll(/^\s+([A-Z_]+): "([^"]*)"/gm)].map(m => [m[1], m[2]]));
  assert.deepEqual(env, {
    APP_ENV: 'staging', PORT: '4100', TRUST_PROXY: 'true', HTTPS_ONLY: 'true', DATABASE_URL: 'memory', PAYMENT_MODE: 'test',
    ALLOW_DEMO_INVENTORY: 'true', ENABLE_TRIPS: 'true', ENABLE_BUSINESS: 'true', PREVIEW_SEED: 'business',
  });
  assert.match(block, /PREVIEW_PASSWORD: env\.PREVIEW_PASSWORD,/);
  assert.match(block, /ADMIN_EMAILS: \(env\.ADMIN_EMAILS \/\/ ""\),/);
  assert.match(workflow, /if \(env\.DUFFEL_TEST_TOKEN \/\/ ""\) != "" then \{ DUFFEL_TEST_TOKEN: env\.DUFFEL_TEST_TOKEN \} else \{\} end/);
  assert.match(workflow, /if \(env\.LITEAPI_SANDBOX_KEY \/\/ ""\) != "" then \{ LITEAPI_SANDBOX_KEY: env\.LITEAPI_SANDBOX_KEY \} else \{\} end/);
  const config = loadConfig({ ...env, PREVIEW_PASSWORD: 'a-test-password-only', ADMIN_EMAILS: '' });
  assert.equal(config.appEnv, 'staging');
  assert.equal(config.databaseUrl, 'memory');
  assert.equal(config.business.enabled, true);
  assert.equal(config.allowDemoInventory, true);
  assert.equal(config.payment.mode, 'test');
  assert.equal(config.trustProxy, true);
  assert.ok(config.preview.gate);
  assert.equal(config.preview.seed, 'business');
  assert.equal(config.port, 4100);
  assert.match(workflow, /"containerName":|containerName: "web"/);
  assert.match(workflow, /path: "\/healthz", successCodes: "200"/, 'the health check uses the open path');
  assert.match(workflow, /ports: \{ "4100": "HTTP" \}/);
});

test('the stack: a micro Lightsail service, a 5-image registry, a generated password and a branch-only role', () => {
  const body = code(stack);
  const types = [...body.matchAll(/^\s+Type: (AWS::[A-Za-z0-9:]+)/gm)].map(m => m[1]).sort();
  assert.deepEqual(types, ['AWS::ECR::Repository', 'AWS::IAM::Role', 'AWS::Lightsail::Container', 'AWS::SecretsManager::Secret']);

  assert.match(body, /ServiceName: tripelyx-preview\n\s+Power: micro\n\s+Scale: 1\n/);
  assert.match(body, /PrivateRegistryAccess:\n\s+EcrImagePullerRole:\n\s+IsActive: true\n/);
  assert.doesNotMatch(body, /^\s+(ContainerServiceDeployment|PublicDomainNames):/m, 'the workflow owns deployments; the default domain is used');

  assert.match(body, /RepositoryName: tripelyx-preview\n/);
  assert.match(body, /"countType":"imageCountMoreThan","countNumber":5\}/);
  assert.match(body, /AWS: !GetAtt PreviewService\.PrivateRegistryAccess\.EcrImagePullerRole\.PrincipalArn/);
  assert.match(body, /- ecr:BatchGetImage\n\s+- ecr:GetDownloadUrlForLayer\n/);

  assert.match(body, /GenerateSecretString:\n\s+PasswordLength: 24\n/);
  assert.doesNotMatch(body, /^\s+SecretString:/m, 'the password is generated, never written here');
  assert.doesNotMatch(stack, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/);

  assert.match(body, /RoleName: tripelyx-github-preview\n/);
  assert.match(body, /Federated: !Sub arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:oidc-provider\/token\.actions\.githubusercontent\.com\n/);
  assert.doesNotMatch(body, /AWS::IAM::OIDCProvider/, 'the existing identity provider is reused');
  assert.match(body, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com\n/);
  const subs = [...body.matchAll(/- !Sub (repo:.*)$/gm)].map(m => m[1]);
  assert.deepEqual(subs, [
    `repo:\${GitHubOwner}/\${GitHubRepo}:ref:refs/heads/${BRANCH}`,
    `repo:\${GitHubOwner}@\${GitHubOwnerId}/\${GitHubRepo}@\${GitHubRepoId}:ref:refs/heads/${BRANCH}`,
  ]);
  assert.match(body, /StringEquals:\n\s+token\.actions/);
  assert.doesNotMatch(body, /StringLike|refs\/heads\/main|\bmain\b|:pull_request|:environment:/);
  for (const [name, value] of [['GitHubOwnerId', "'335752477'"], ['GitHubRepoId', "'1405020835'"], ['GitHubOwner', 'moatazelgendy-create'], ['GitHubRepo', 'tripelyx']]) {
    assert.match(body, new RegExp(`  ${name}:\\n\\s+Type: String\\n\\s+Default: ${value}\\n`), name);
  }
});

test('the preview role has least privilege: the one registry, the one secret, the one service', () => {
  const body = code(stack);
  const actions = [...body.matchAll(/^\s+(?:- |Action: )([a-z0-9-]+:[A-Za-z*]+)\s*$/gm)].map(m => m[1]).sort();
  assert.deepEqual(actions, [
    'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:BatchGetImage', 'ecr:CompleteLayerUpload', 'ecr:DescribeImages',
    'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer', 'ecr:InitiateLayerUpload', 'ecr:PutImage', 'ecr:UploadLayerPart',
    'lightsail:CreateContainerServiceDeployment', 'lightsail:GetContainerLog', 'lightsail:GetContainerServiceDeployments', 'lightsail:GetContainerServices',
    'secretsmanager:GetSecretValue', 'sts:AssumeRoleWithWebIdentity',
  ]);
  assert.doesNotMatch(body, /AdministratorAccess|ManagedPolicyArns|iam:PassRole|Action: '\*'|:\*\b/);
  const statement = sid => {
    const i = body.indexOf(`Sid: ${sid}`);
    assert.ok(i > 0, sid);
    const next = body.indexOf('- Sid:', i + 1);
    return body.slice(i, next < 0 ? undefined : next);
  };
  assert.match(statement('EcrPushPreviewImages'), /Resource: !GetAtt PreviewRepository\.Arn/);
  assert.match(statement('ReadPreviewPassword'), /Resource: !Ref PreviewPassword/);
  assert.match(statement('DeployPreviewService'), /Resource: !GetAtt PreviewService\.ContainerArn/);
  assert.match(statement('EcrLogin'), /Action: ecr:GetAuthorizationToken\n\s+Resource: '\*'/);
  assert.match(statement('ReadPreviewService'), /Resource: '\*'/, 'Lightsail reads take no resource ARN');
  for (const out of ['PreviewRoleArn', 'ServiceName', 'Url', 'RepositoryUri', 'PasswordSecretName']) assert.match(body, new RegExp(`\\n  ${out}:\\n`), out);
  assert.match(body, /Value: !GetAtt PreviewService\.Url/);
});

test('the live site’s deploy files are left alone', () => {
  const deploy = read('.github/workflows/deploy.yml');
  assert.match(deploy, /on:\n {2}push:\n {4}branches: \[main\]\n/);
  assert.doesNotMatch(deploy, /preview/i);
  for (const f of ['infra/app.yaml', 'infra/bootstrap.yaml']) assert.doesNotMatch(read(f), /preview|lightsail/i, f);
});
