// Demo destinations for the budget trip planner. Invented hotels, ratings, rates and activities; see
// README.md in this folder. Rates are USD.
//
// hotels:     [id, name, stars, demo rating (of 5), nightly rate per room, features, area, mandatory resort fee per room-night]
//             features: B breakfast, P pool, F beachfront, A adults only, I all-inclusive, R free cancellation,
//                       K family friendly, S spa
// activities: [id, name, price per person, hours, kind]
// climate:    tropical (warm all year), subtropical (warm Mar–Nov), mediterranean (warm May–Oct),
//             temperate (warm Jun–Sep), desert (warm Mar–Nov, hot summers), cool (never warm)
const DESTINATIONS = [
  {
    id: 'cancun', name: 'Cancun', country: 'Mexico', airport: 'CUN', lat: 21.04, lon: -86.87,
    regions: ['beach', 'mexico', 'international'], styles: ['beach', 'romantic', 'family', 'nightlife', 'relaxing', 'luxury'],
    climate: 'tropical', peak: [12, 1, 2, 3, 7], hotelTax: 19, transfer: 38, passport: true, scene: 'beach',
    blurb: 'Turquoise Caribbean water, long white beaches and an easy hotel zone.',
    hotels: [
      ['cun-1', 'Playa Coral Inn', 3, 4.1, 104, 'BPR', 'Downtown, 10 min to the beach'],
      ['cun-2', 'Laguna Azul Resort', 4, 4.5, 172, 'BPFRS', 'Hotel Zone beachfront'],
      ['cun-3', 'Costa Blanca All-Inclusive', 4, 4.4, 265, 'IPFKR', 'Hotel Zone beachfront'],
      ['cun-4', 'Mar de Luna Adults Resort', 5, 4.8, 390, 'IPFASR', 'Quiet north beach'],
    ],
    activities: [
      ['cun-a1', 'Cenote swim and jungle bike tour', 74, 5, 'adventure'],
      ['cun-a2', 'Isla Mujeres catamaran day', 89, 7, 'beach'],
      ['cun-a3', 'Chichén Itzá early-access tour', 118, 11, 'culture'],
      ['cun-a4', 'Reef snorkel trip', 52, 3, 'beach'],
    ],
  },
  {
    id: 'puerto-vallarta', name: 'Puerto Vallarta', country: 'Mexico', airport: 'PVR', lat: 20.68, lon: -105.25,
    regions: ['beach', 'mexico', 'international'], styles: ['beach', 'romantic', 'relaxing', 'family'],
    climate: 'tropical', peak: [12, 1, 2, 3], hotelTax: 19, transfer: 30, passport: true, scene: 'sunset',
    blurb: 'Cobblestone old town, mountain views and a calm bay for swimming.',
    hotels: [
      ['pvr-1', 'Casa Malecón Hotel', 3, 4.2, 92, 'BR', 'Old town, steps from the boardwalk'],
      ['pvr-2', 'Bahía Verde Resort', 4, 4.5, 158, 'BPFRS', 'Marina Vallarta beachfront'],
      ['pvr-3', 'Sierra Mar All-Inclusive', 4, 4.3, 238, 'IPFKR', 'Nuevo Vallarta beachfront'],
    ],
    activities: [
      ['pvr-a1', 'Marietas Islands boat and snorkel', 95, 6, 'beach'],
      ['pvr-a2', 'Old town food walk', 58, 3, 'culture'],
      ['pvr-a3', 'Sierra Madre zipline', 84, 4, 'adventure'],
    ],
  },
  {
    id: 'los-cabos', name: 'Los Cabos', country: 'Mexico', airport: 'SJD', lat: 23.15, lon: -109.72,
    regions: ['beach', 'mexico', 'international'], styles: ['beach', 'luxury', 'romantic', 'nightlife', 'relaxing'],
    climate: 'subtropical', peak: [12, 1, 2, 3, 4], hotelTax: 19, transfer: 45, passport: true, scene: 'lagoon',
    blurb: 'Desert meets ocean: dramatic arches, sunsets and polished resorts.',
    hotels: [
      ['sjd-1', 'Cabo Arco Hotel', 3, 4.0, 138, 'PR', 'Cabo San Lucas marina'],
      ['sjd-2', 'Desierto Azul Resort', 4, 4.6, 228, 'BPFRS', 'Tourist Corridor beachfront'],
      ['sjd-3', 'Punta Brisa Grand', 5, 4.8, 420, 'IPFASR', 'Quiet cove, adults only'],
    ],
    activities: [
      ['sjd-a1', 'El Arco glass-bottom boat', 45, 2, 'beach'],
      ['sjd-a2', 'Whale-watching cruise (Dec–Apr)', 99, 3, 'adventure'],
      ['sjd-a3', 'Desert ATV ride', 110, 4, 'adventure'],
    ],
  },
  {
    id: 'punta-cana', name: 'Punta Cana', country: 'Dominican Republic', airport: 'PUJ', lat: 18.57, lon: -68.36,
    regions: ['beach', 'caribbean', 'international'], styles: ['beach', 'relaxing', 'family', 'romantic', 'luxury'],
    climate: 'tropical', peak: [12, 1, 2, 3], hotelTax: 18, transfer: 40, passport: true, scene: 'beach',
    blurb: 'Palm-lined beaches and some of the Caribbean’s best all-inclusive value.',
    hotels: [
      ['puj-1', 'Bávaro Sol Hotel', 3, 4.0, 98, 'BPR', 'Bávaro, 5 min walk to the beach'],
      ['puj-2', 'Coco Palma All-Inclusive', 4, 4.4, 215, 'IPFKR', 'Bávaro beachfront'],
      ['puj-3', 'Arena Dorada Resort', 5, 4.7, 345, 'IPFSR', 'Cap Cana beachfront'],
    ],
    activities: [
      ['puj-a1', 'Saona Island catamaran', 92, 9, 'beach'],
      ['puj-a2', 'Hoyo Azul cenote and zipline', 105, 5, 'adventure'],
      ['puj-a3', 'Sunset horseback ride', 64, 2, 'romantic'],
    ],
  },
  {
    id: 'san-juan', name: 'San Juan', country: 'Puerto Rico', airport: 'SJU', lat: 18.44, lon: -66.00,
    regions: ['beach', 'caribbean', 'usa'], styles: ['beach', 'nightlife', 'romantic', 'city', 'family'],
    climate: 'tropical', peak: [12, 1, 2, 3], hotelTax: 11, transfer: 32, passport: false, scene: 'islands',
    blurb: 'Caribbean beaches and a 500-year-old city, no passport needed from the US.',
    hotels: [
      ['sju-1', 'Condado Breeze Hotel', 3, 4.1, 128, 'PR', 'Condado, one block from the beach'],
      ['sju-2', 'Isla Verde Beach Resort', 4, 4.4, 205, 'BPFRS', 'Isla Verde beachfront'],
      ['sju-3', 'Fortaleza Grand', 5, 4.7, 340, 'BPFSR', 'Condado beachfront', 30],
    ],
    activities: [
      ['sju-a1', 'Bioluminescent bay kayak', 68, 3, 'adventure'],
      ['sju-a2', 'Old San Juan walking tour', 39, 2, 'culture'],
      ['sju-a3', 'El Yunque rainforest hike', 85, 6, 'adventure'],
    ],
  },
  {
    id: 'montego-bay', name: 'Montego Bay', country: 'Jamaica', airport: 'MBJ', lat: 18.50, lon: -77.91,
    regions: ['beach', 'caribbean', 'international'], styles: ['beach', 'romantic', 'relaxing', 'nightlife'],
    climate: 'tropical', peak: [12, 1, 2, 3], hotelTax: 15, transfer: 36, passport: true, scene: 'lagoon',
    blurb: 'Reggae, reef snorkeling and laid-back beach days.',
    hotels: [
      ['mbj-1', 'Hip Strip Guesthouse', 3, 3.9, 110, 'BPR', 'Hip Strip, across from the beach'],
      ['mbj-2', 'Blue Hole Beach Resort', 4, 4.4, 228, 'IPFKR', 'Rose Hall beachfront'],
      ['mbj-3', 'Coral Cove Adults Resort', 5, 4.7, 360, 'IPFASR', 'Secluded cove, adults only'],
    ],
    activities: [
      ['mbj-a1', 'Dunn’s River Falls climb', 79, 6, 'adventure'],
      ['mbj-a2', 'Catamaran snorkel cruise', 75, 4, 'beach'],
      ['mbj-a3', 'Rum and food tasting', 62, 3, 'culture'],
    ],
  },
  {
    id: 'miami-beach', name: 'Miami Beach', country: 'USA', airport: 'MIA', lat: 25.80, lon: -80.29,
    regions: ['beach', 'usa'], styles: ['beach', 'nightlife', 'city', 'luxury', 'romantic'],
    climate: 'subtropical', peak: [12, 1, 2, 3], hotelTax: 14, transfer: 42, passport: false, scene: 'towers',
    blurb: 'Art Deco streets, a buzzing food scene and ocean swims before brunch.',
    hotels: [
      ['mia-1', 'Collins Deco Hotel', 3, 4.0, 142, 'R', 'South Beach, 2 blocks to the sand', 25],
      ['mia-2', 'Ocean Drive Palms', 4, 4.4, 232, 'BPFR', 'South Beach oceanfront', 35],
      ['mia-3', 'Biscayne Grand', 5, 4.7, 410, 'PFSR', 'Mid-Beach oceanfront', 45],
    ],
    activities: [
      ['mia-a1', 'Everglades airboat ride', 62, 3, 'adventure'],
      ['mia-a2', 'Little Havana food walk', 69, 3, 'culture'],
      ['mia-a3', 'Biscayne Bay sunset cruise', 48, 2, 'romantic'],
    ],
  },
  {
    id: 'honolulu', name: 'Honolulu', country: 'USA', airport: 'HNL', lat: 21.32, lon: -157.92,
    regions: ['beach', 'usa'], styles: ['beach', 'family', 'romantic', 'adventure', 'relaxing'],
    climate: 'tropical', peak: [12, 1, 2, 6, 7, 8], hotelTax: 18, transfer: 48, passport: false, scene: 'sunset',
    blurb: 'Waikīkī surf lessons, volcanic hikes and warm water all year.',
    hotels: [
      ['hnl-1', 'Kūhiō Garden Hotel', 3, 4.0, 168, 'PR', 'Waikīkī, 3 blocks to the beach', 30],
      ['hnl-2', 'Waikīkī Shores Resort', 4, 4.5, 285, 'PFKR', 'Waikīkī beachfront', 45],
      ['hnl-3', 'Diamond Head Grand', 5, 4.8, 470, 'BPFSR', 'Kapiʻolani beachfront', 50],
    ],
    activities: [
      ['hnl-a1', 'Diamond Head sunrise hike', 45, 3, 'adventure'],
      ['hnl-a2', 'Surf lesson in Waikīkī', 89, 2, 'adventure'],
      ['hnl-a3', 'North Shore day trip', 139, 9, 'beach'],
    ],
  },
  {
    id: 'las-vegas', name: 'Las Vegas', country: 'USA', airport: 'LAS', lat: 36.08, lon: -115.15,
    regions: ['usa', 'weekend'], styles: ['nightlife', 'city', 'luxury'],
    climate: 'desert', peak: [3, 4, 10, 11], hotelTax: 13, transfer: 28, passport: false, scene: 'night',
    blurb: 'Shows, pools and big dinners, with the desert a short drive away.',
    hotels: [
      ['las-1', 'Neon Row Hotel', 3, 3.9, 68, 'PR', 'Off-Strip, free shuttle', 35],
      ['las-2', 'Mirage Sands Resort', 4, 4.4, 145, 'PSR', 'Center Strip', 45],
      ['las-3', 'Sapphire Tower', 5, 4.7, 290, 'PSR', 'Center Strip, suites', 50],
    ],
    activities: [
      ['las-a1', 'Grand Canyon West day trip', 159, 11, 'adventure'],
      ['las-a2', 'Evening show ticket', 95, 2, 'nightlife'],
      ['las-a3', 'Red Rock Canyon e-bike', 99, 4, 'adventure'],
    ],
  },
  {
    id: 'new-orleans', name: 'New Orleans', country: 'USA', airport: 'MSY', lat: 29.99, lon: -90.26,
    regions: ['usa', 'weekend'], styles: ['city', 'nightlife', 'romantic'],
    climate: 'subtropical', peak: [2, 3, 4, 10], hotelTax: 16, transfer: 36, passport: false, scene: 'city',
    blurb: 'Live jazz, Creole cooking and balconies in the French Quarter.',
    hotels: [
      ['msy-1', 'Magazine Street Inn', 3, 4.1, 118, 'BR', 'Garden District'],
      ['msy-2', 'Royal Courtyard Hotel', 4, 4.5, 198, 'BPR', 'French Quarter'],
      ['msy-3', 'Riverbend Grand', 5, 4.7, 320, 'PSR', 'Warehouse District'],
    ],
    activities: [
      ['msy-a1', 'Swamp boat tour', 59, 3, 'adventure'],
      ['msy-a2', 'Creole cooking class', 85, 3, 'culture'],
      ['msy-a3', 'Jazz club evening', 45, 3, 'nightlife'],
    ],
  },
  {
    id: 'new-york', name: 'New York City', country: 'USA', airport: 'JFK', lat: 40.64, lon: -73.78,
    regions: ['usa', 'weekend'], styles: ['city', 'nightlife', 'romantic', 'luxury'],
    climate: 'temperate', peak: [5, 6, 9, 10, 12], hotelTax: 15, transfer: 70, passport: false, scene: 'towers',
    blurb: 'Museums, Broadway and neighborhoods to walk for days.',
    hotels: [
      ['nyc-1', 'Hudson Yard Hotel', 3, 4.0, 178, 'R', 'Midtown West'],
      ['nyc-2', 'Gramercy Lane Hotel', 4, 4.5, 285, 'BR', 'Flatiron'],
      ['nyc-3', 'Park Avenue Grand', 5, 4.8, 520, 'SR', 'Midtown East'],
    ],
    activities: [
      ['nyc-a1', 'Broadway show ticket', 135, 3, 'nightlife'],
      ['nyc-a2', 'Harbor and Statue cruise', 42, 2, 'culture'],
      ['nyc-a3', 'Brooklyn food walk', 75, 3, 'culture'],
    ],
  },
  {
    id: 'san-diego', name: 'San Diego', country: 'USA', airport: 'SAN', lat: 32.73, lon: -117.19,
    regions: ['beach', 'usa', 'weekend'], styles: ['beach', 'family', 'relaxing', 'city'],
    climate: 'mediterranean', peak: [6, 7, 8], hotelTax: 12.5, transfer: 30, passport: false, scene: 'beach',
    blurb: 'Easy beaches, tacos and sunshine almost every day.',
    hotels: [
      ['san-1', 'Gaslamp Corner Hotel', 3, 4.0, 128, 'R', 'Gaslamp Quarter'],
      ['san-2', 'Mission Bay Resort', 4, 4.4, 215, 'BPFKR', 'Mission Bay waterfront'],
      ['san-3', 'Coronado Shores Grand', 5, 4.7, 380, 'PFSR', 'Coronado beachfront', 35],
    ],
    activities: [
      ['san-a1', 'La Jolla sea-cave kayak', 59, 2, 'adventure'],
      ['san-a2', 'Zoo day ticket', 72, 6, 'family'],
      ['san-a3', 'Harbor sunset sail', 55, 2, 'romantic'],
    ],
  },
  {
    id: 'nashville', name: 'Nashville', country: 'USA', airport: 'BNA', lat: 36.12, lon: -86.68,
    regions: ['usa', 'weekend'], styles: ['nightlife', 'city'],
    climate: 'temperate', peak: [4, 5, 9, 10], hotelTax: 15.25, transfer: 32, passport: false, scene: 'night',
    blurb: 'Live music on every block and hot chicken to match.',
    hotels: [
      ['bna-1', 'Music Row Inn', 3, 4.0, 122, 'BR', 'Music Row'],
      ['bna-2', 'Broadway Lights Hotel', 4, 4.4, 210, 'PR', 'Downtown'],
      ['bna-3', 'Cumberland Grand', 5, 4.7, 330, 'PSR', 'The Gulch'],
    ],
    activities: [
      ['bna-a1', 'Opry evening ticket', 89, 3, 'nightlife'],
      ['bna-a2', 'Music history walking tour', 35, 2, 'culture'],
      ['bna-a3', 'Whiskey distillery visit', 49, 2, 'culture'],
    ],
  },
  {
    id: 'lisbon', name: 'Lisbon', country: 'Portugal', airport: 'LIS', lat: 38.77, lon: -9.13,
    regions: ['europe', 'international'], styles: ['city', 'romantic', 'beach', 'nightlife'],
    climate: 'mediterranean', peak: [6, 7, 8, 9], hotelTax: 6, transfer: 34, passport: true, scene: 'city',
    nonstopFrom: ['JFK', 'EWR', 'BOS', 'MIA', 'SFO', 'ORD'],
    blurb: 'Hilltop viewpoints, tiled streets and beaches a train ride away.',
    hotels: [
      ['lis-1', 'Alfama Tiles Hotel', 3, 4.3, 98, 'BR', 'Alfama'],
      ['lis-2', 'Chiado Terrace Hotel', 4, 4.6, 168, 'BRS', 'Chiado'],
      ['lis-3', 'Tejo Palace', 5, 4.8, 310, 'BPSR', 'Avenida da Liberdade'],
    ],
    activities: [
      ['lis-a1', 'Sintra palaces day trip', 85, 8, 'culture'],
      ['lis-a2', 'Fado dinner evening', 72, 3, 'romantic'],
      ['lis-a3', 'Tram 28 and food tour', 59, 3, 'culture'],
    ],
  },
  {
    id: 'barcelona', name: 'Barcelona', country: 'Spain', airport: 'BCN', lat: 41.30, lon: 2.08,
    regions: ['europe', 'beach', 'international'], styles: ['city', 'beach', 'nightlife', 'romantic'],
    climate: 'mediterranean', peak: [6, 7, 8, 9], hotelTax: 10, transfer: 40, passport: true, scene: 'city',
    nonstopFrom: ['JFK', 'EWR', 'MIA', 'ATL', 'ORD', 'BOS', 'SFO', 'LAX'],
    blurb: 'Gaudí, tapas and a city beach, all in one long weekend or a whole week.',
    hotels: [
      ['bcn-1', 'Gràcia Garden Hotel', 3, 4.1, 128, 'BR', 'Gràcia'],
      ['bcn-2', 'Eixample Modern Hotel', 4, 4.5, 208, 'BPR', 'Eixample'],
      ['bcn-3', 'Barceloneta Sea Palace', 5, 4.7, 380, 'BPFSR', 'Barceloneta beachfront'],
    ],
    activities: [
      ['bcn-a1', 'Sagrada Família guided entry', 62, 2, 'culture'],
      ['bcn-a2', 'Tapas and wine walk', 79, 3, 'culture'],
      ['bcn-a3', 'Montserrat half day', 69, 5, 'adventure'],
    ],
  },
  {
    id: 'paris', name: 'Paris', country: 'France', airport: 'CDG', lat: 49.01, lon: 2.55,
    regions: ['europe', 'international'], styles: ['city', 'romantic', 'luxury'],
    climate: 'temperate', peak: [5, 6, 7, 9, 12], hotelTax: 8, transfer: 65, passport: true, scene: 'museum',
    nonstopFrom: ['JFK', 'EWR', 'BOS', 'MIA', 'ATL', 'ORD', 'IAH', 'DFW', 'DEN', 'SEA', 'SFO', 'LAX'],
    blurb: 'Cafés, museums and evening walks along the Seine.',
    hotels: [
      ['cdg-1', 'Canal Saint-Martin Hotel', 3, 4.1, 148, 'R', 'Canal Saint-Martin'],
      ['cdg-2', 'Marais Courtyard Hotel', 4, 4.6, 255, 'BR', 'Le Marais'],
      ['cdg-3', 'Rive Gauche Palace', 5, 4.8, 520, 'BSR', 'Saint-Germain'],
    ],
    activities: [
      ['cdg-a1', 'Louvre timed entry with guide', 79, 3, 'culture'],
      ['cdg-a2', 'Seine dinner cruise', 115, 3, 'romantic'],
      ['cdg-a3', 'Versailles half day', 95, 5, 'culture'],
    ],
  },
  {
    id: 'rome', name: 'Rome', country: 'Italy', airport: 'FCO', lat: 41.80, lon: 12.25,
    regions: ['europe', 'international'], styles: ['city', 'romantic'],
    climate: 'mediterranean', peak: [4, 5, 6, 9, 10], hotelTax: 7, transfer: 55, passport: true, scene: 'museum',
    nonstopFrom: ['JFK', 'EWR', 'BOS', 'MIA', 'ATL', 'ORD', 'DFW', 'IAH'],
    blurb: 'Ancient ruins, Renaissance art and long dinners outside.',
    hotels: [
      ['fco-1', 'Trastevere Courtyard Hotel', 3, 4.2, 122, 'BR', 'Trastevere'],
      ['fco-2', 'Piazza Navona Suites', 4, 4.6, 215, 'BR', 'Centro Storico'],
      ['fco-3', 'Villa Borghese Palace', 5, 4.8, 450, 'BPSR', 'Via Veneto'],
    ],
    activities: [
      ['fco-a1', 'Colosseum and Forum guided entry', 75, 3, 'culture'],
      ['fco-a2', 'Vatican Museums early entry', 89, 3, 'culture'],
      ['fco-a3', 'Pasta-making class', 69, 3, 'culture'],
    ],
  },
  {
    id: 'reykjavik', name: 'Reykjavík', country: 'Iceland', airport: 'KEF', lat: 63.98, lon: -22.61,
    regions: ['europe', 'international'], styles: ['adventure', 'romantic'],
    climate: 'cool', peak: [6, 7, 8, 12], hotelTax: 11, transfer: 60, passport: true, scene: 'mountain',
    nonstopFrom: ['JFK', 'EWR', 'BOS', 'ORD', 'SEA', 'DEN', 'SFO', 'MIA', 'DFW'],
    blurb: 'Glaciers, geothermal lagoons and, in winter, the northern lights.',
    hotels: [
      ['kef-1', 'Harbor Light Guesthouse', 3, 4.2, 138, 'BR', 'Old Harbor'],
      ['kef-2', 'Laugavegur Design Hotel', 4, 4.5, 225, 'BSR', 'Downtown'],
      ['kef-3', 'Aurora Ridge Lodge', 5, 4.8, 410, 'BSR', 'Countryside, 40 min from town'],
    ],
    activities: [
      ['kef-a1', 'Golden Circle day tour', 99, 8, 'adventure'],
      ['kef-a2', 'Geothermal lagoon entry', 85, 3, 'relaxing'],
      ['kef-a3', 'Northern lights trip (Sep–Mar)', 79, 4, 'adventure'],
    ],
  },
  {
    id: 'tokyo', name: 'Tokyo', country: 'Japan', airport: 'HND', lat: 35.55, lon: 139.78,
    regions: ['asia', 'international'], styles: ['city', 'adventure', 'nightlife'],
    climate: 'temperate', peak: [3, 4, 10, 11], hotelTax: 10, transfer: 45, passport: true, scene: 'temple',
    nonstopFrom: ['SFO', 'LAX', 'SEA', 'JFK', 'ORD', 'DFW', 'IAH', 'ATL', 'BOS', 'DEN'],
    blurb: 'Neon nights, quiet shrines and the best food city on the planet.',
    hotels: [
      ['hnd-1', 'Asakusa Lantern Hotel', 3, 4.3, 108, 'R', 'Asakusa'],
      ['hnd-2', 'Shibuya Sky Hotel', 4, 4.6, 198, 'BR', 'Shibuya'],
      ['hnd-3', 'Marunouchi Palace', 5, 4.9, 480, 'BSR', 'Marunouchi'],
    ],
    activities: [
      ['hnd-a1', 'Tsukiji market food tour', 89, 3, 'culture'],
      ['hnd-a2', 'Mount Fuji day trip', 129, 10, 'adventure'],
      ['hnd-a3', 'Izakaya evening walk', 75, 3, 'nightlife'],
    ],
  },
  {
    id: 'bali', name: 'Bali', country: 'Indonesia', airport: 'DPS', lat: -8.75, lon: 115.17,
    regions: ['asia', 'beach', 'international'], styles: ['beach', 'romantic', 'relaxing', 'adventure', 'luxury'],
    climate: 'tropical', peak: [7, 8, 12], hotelTax: 21, transfer: 22, passport: true, scene: 'villa',
    blurb: 'Rice terraces, temples, surf and private pool villas at friendly prices.',
    hotels: [
      ['dps-1', 'Ubud Rice Field Hotel', 3, 4.4, 64, 'BPR', 'Ubud'],
      ['dps-2', 'Seminyak Garden Villas', 4, 4.6, 128, 'BPRS', 'Seminyak, private pool'],
      ['dps-3', 'Uluwatu Cliff Resort', 5, 4.8, 290, 'BPFASR', 'Uluwatu clifftop'],
    ],
    activities: [
      ['dps-a1', 'Mount Batur sunrise trek', 55, 7, 'adventure'],
      ['dps-a2', 'Temple and rice terrace tour', 45, 8, 'culture'],
      ['dps-a3', 'Balinese spa ritual', 48, 2, 'relaxing'],
    ],
  },
  {
    id: 'bangkok', name: 'Bangkok', country: 'Thailand', airport: 'BKK', lat: 13.69, lon: 100.75,
    regions: ['asia', 'international'], styles: ['city', 'nightlife', 'adventure'],
    climate: 'tropical', peak: [11, 12, 1, 2], hotelTax: 17, transfer: 25, passport: true, scene: 'temple',
    blurb: 'Golden temples, river ferries and street food until late.',
    hotels: [
      ['bkk-1', 'Riverside Lane Hotel', 3, 4.2, 52, 'BPR', 'Riverside'],
      ['bkk-2', 'Sukhumvit Sky Hotel', 4, 4.5, 105, 'BPSR', 'Sukhumvit'],
      ['bkk-3', 'Chao Phraya Grand', 5, 4.8, 230, 'BPSR', 'Riverside'],
    ],
    activities: [
      ['bkk-a1', 'Grand Palace and temples tour', 49, 4, 'culture'],
      ['bkk-a2', 'Street food night tour', 55, 4, 'nightlife'],
      ['bkk-a3', 'Floating market morning', 62, 6, 'culture'],
    ],
  },
  {
    id: 'guanacaste', name: 'Guanacaste', country: 'Costa Rica', airport: 'LIR', lat: 10.59, lon: -85.54,
    regions: ['beach', 'international'], styles: ['adventure', 'beach', 'family', 'relaxing'],
    climate: 'tropical', peak: [12, 1, 2, 3, 4], hotelTax: 13, transfer: 45, passport: true, scene: 'lagoon',
    blurb: 'Volcano hikes, zip lines and Pacific beaches in one trip.',
    hotels: [
      ['lir-1', 'Tamarindo Surf Lodge', 3, 4.2, 112, 'BPR', 'Tamarindo'],
      ['lir-2', 'Papagayo Bay Resort', 4, 4.5, 228, 'IPFKR', 'Papagayo beachfront'],
      ['lir-3', 'Rincón Rainforest Lodge', 4, 4.7, 195, 'BPSR', 'Near Rincón de la Vieja'],
    ],
    activities: [
      ['lir-a1', 'Canopy zipline tour', 85, 3, 'adventure'],
      ['lir-a2', 'Volcano hot springs day', 98, 7, 'adventure'],
      ['lir-a3', 'Sunset catamaran', 89, 4, 'romantic'],
    ],
  },
  {
    id: 'new-alamein', name: 'New Alamein', country: 'Egypt', airport: 'DBB', lat: 30.92, lon: 28.46,
    regions: ['beach', 'international'], styles: ['beach', 'relaxing', 'family', 'luxury'],
    climate: 'mediterranean', peak: [6, 7, 8, 9], hotelTax: 14, transfer: 25, passport: true, scene: 'towers',
    nonstopFrom: [],
    blurb: 'White sand and turquoise Mediterranean water on Egypt’s North Coast.',
    hotels: [
      ['dbb-1', 'Alamein Marina Hotel', 3, 4.1, 78, 'BPR', 'Marina, 5 min to the beach'],
      ['dbb-2', 'North Coast Towers Resort', 4, 4.5, 140, 'BPFKR', 'Downtown beachfront'],
      ['dbb-3', 'Lagoon Bay Grand', 5, 4.8, 260, 'BPFSR', 'Lagoon beachfront'],
    ],
    activities: [
      ['dbb-a1', 'Yacht half day from the marina', 85, 4, 'beach'],
      ['dbb-a2', 'El Alamein memorials and museum', 35, 4, 'culture'],
      ['dbb-a3', 'Desert safari at sunset', 59, 4, 'adventure'],
    ],
  },
];

module.exports = { DESTINATIONS };
