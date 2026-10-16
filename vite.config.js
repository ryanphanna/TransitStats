
import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';

const themeBootstrap = fs.readFileSync(new URL('./js/theme.js', import.meta.url), 'utf8');
const requiredFirebaseEnv = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
];

export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const missingFirebaseEnv = requiredFirebaseEnv.filter((key) => !env[key]);
    if (command === 'build' && missingFirebaseEnv.length > 0) {
        throw new Error(`Missing Firebase build configuration: ${missingFirebaseEnv.join(', ')}`);
    }

    return {
        root: './',
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            rollupOptions: {
                input: {
                    index: './index.html',
                    public: './public.html',
                    dashboard: './dashboard.html',
                    terms: './terms.html',
                    privacy: './privacy.html',
                    import: './import.html',
                    'route-heatmap': './route-heatmap.html',
                    recap: './recap.html',
                },
                output: {
                    // Name the shared vendor chunk after what it is (Rollup otherwise borrows a module's name).
                    manualChunks(id) {
                        if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
                        if (id.includes('node_modules/lucide')) return 'lucide';
                        return undefined;
                    },
                    entryFileNames: (chunkInfo) => chunkInfo.name === 'public'
                        ? 'assets/public.js'
                        : 'assets/[name]-[hash].js',
                    assetFileNames: (assetInfo) => assetInfo.name === 'main.css'
                        ? 'assets/main.css'
                        : 'assets/[name]-[hash][extname]',
                },
            },
        },
        server: {
            // Keep Firebase's localhost session on one origin. Vite otherwise
            // silently increments the port when another dev server is running,
            // which makes a valid session appear logged out.
            port: 5177,
            strictPort: true,
            open: false,
        },
        plugins: [
            {
                name: 'html-ext-fallback',
                configureServer(server) {
                const atlasCache = new Map();
                let atlasAgencyDirectory;

                const normalizeAgency = (value) => String(value || '')
                    .normalize('NFKD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/&/g, ' and ')
                    .replace(/[^a-z0-9]+/g, ' ')
                    .trim();

                const resolveAtlasAgency = async (value) => {
                    const requested = normalizeAgency(value);
                    if (!requested) return null;
                    if (!atlasAgencyDirectory) {
                        const response = await fetch('https://data.transitatlas.fyi/atlas/agencies.json');
                        if (!response.ok) throw new Error(`Atlas agency directory returned ${response.status}`);
                        const data = await response.json();
                        atlasAgencyDirectory = Array.isArray(data.agencies) ? data.agencies : [];
                    }
                    const exactSlug = atlasAgencyDirectory.find(agency => normalizeAgency(agency.slug) === requested);
                    if (exactSlug) return exactSlug.slug;
                    const exactName = atlasAgencyDirectory.find(agency => normalizeAgency(agency.name) === requested);
                    if (exactName) return exactName.slug;
                    const firstToken = requested.split(' ')[0];
                    const tokenMatches = atlasAgencyDirectory.filter(agency => {
                        const slug = normalizeAgency(agency.slug);
                        const name = normalizeAgency(agency.name);
                        return slug === firstToken || name.split(' ')[0] === firstToken;
                    });
                    if (tokenMatches.length === 1) return tokenMatches[0].slug;
                    const prefixMatches = atlasAgencyDirectory.filter(agency => {
                        const name = normalizeAgency(agency.name);
                        return name.startsWith(requested) || requested.startsWith(name);
                    });
                    return prefixMatches.length === 1 ? prefixMatches[0].slug : null;
                };

                server.middlewares.use((req, res, next) => {
                    const url = req.url.split('?')[0];
                    if (url === '/wrapped' || url === '/wrapped.html') {
                        res.statusCode = 301;
                        res.setHeader('Location', '/recap' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''));
                        res.end();
                        return;
                    }
                    const targets = ['/dashboard', '/public', '/terms', '/privacy', '/import', '/route-heatmap', '/recap'];
                    const isUserProfilePath = url === '/user' || url.startsWith('/user/');
                    if (targets.includes(url)) {
                        req.url = url + '.html' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
                    } else if (isUserProfilePath) {
                        req.url = '/public.html' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
                    }
                    next();
                });

                server.middlewares.use(async (req, res, next) => {
                    const requestUrl = new URL(req.url, 'http://localhost');
                    const match = requestUrl.pathname.match(/^\/atlas-dev\/(stops|routes)$/);
                    if (!match) {
                        next();
                        return;
                    }

                    const requestedAgency = requestUrl.searchParams.get('agency');
                    let agency;
                    try {
                        agency = await resolveAtlasAgency(requestedAgency);
                    } catch (error) {
                        res.statusCode = 502;
                        res.end(JSON.stringify({ error: error.message }));
                        return;
                    }
                    if (!agency) {
                        res.statusCode = 404;
                        res.end(JSON.stringify({ error: 'Agency inventory unavailable' }));
                        return;
                    }

                    try {
                        const artifact = `${agency}${match[1] === 'stops' ? '-stops' : ''}.json`;
                        let data = atlasCache.get(artifact);
                        if (!data) {
                            const response = await fetch(`https://data.transitatlas.fyi/atlas/${artifact}`);
                            if (!response.ok) throw new Error(`Atlas returned ${response.status}`);
                            data = await response.json();
                            atlasCache.set(artifact, data);
                        }

                        if (match[1] === 'routes') {
                            const routes = new Set((requestUrl.searchParams.get('routes') || '').split(',').filter(Boolean));
                            if (requestUrl.searchParams.get('all') === 'true') {
                                const routeMetadata = new Map();
                                for (const feature of data.features || []) {
                                    const props = feature.properties || {};
                                    const routeShortName = String(props.routeShortName || '').trim();
                                    if (!routeShortName || routeMetadata.has(routeShortName)) continue;
                                    routeMetadata.set(routeShortName, {
                                        routeShortName,
                                        routeLongName: String(props.routeLongName || '').trim(),
                                    });
                                }
                                data = { routes: [...routeMetadata.values()] };
                            } else {
                                data = {
                                    type: 'FeatureCollection',
                                    features: (data.features || []).filter(feature => {
                                        const props = feature.properties || {};
                                        return routes.has(String(props.routeShortName || '').trim())
                                            || routes.has(String(props.routeId || '').trim());
                                    })
                                };
                            }
                        }

                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(data));
                    } catch (error) {
                        res.statusCode = 502;
                        res.end(JSON.stringify({ error: error.message }));
                    }
                });
                },
                transformIndexHtml() {
                    const buildId = env.VITE_BUILD_SHA || 'local';
                    return [{
                        tag: 'meta',
                        attrs: {
                            name: 'transitstats-build',
                            content: buildId,
                        },
                        injectTo: 'head-prepend',
                    }, {
                        tag: 'script',
                        children: themeBootstrap,
                        injectTo: 'head-prepend',
                    }];
                }
            }
        ],
        test: {
            globals: true,
            environment: 'jsdom',
            // setupFiles: ['./tests/setup.js'],
            include: ['tests/**/*.test.js'],
            exclude: [
                '**/node_modules/**',
                '**/_legacy_v1/**',
                '**/dist/**',
                '**/.claude/**',
                '**/.agent/**',
                'tests/firestore.rules.test.js',
                'tests/storage.rules.test.js',
            ],
        },
    };
});
