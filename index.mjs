/**
 * ArcGIS ImageServer-Compatible Terrain API (Node.js)
 *
 * This project emulates an ArcGIS Enterprise ImageServer for terrain data,
 * allowing ArcGIS JavaScript SDK applications to consume locally hosted
 * elevation tiles without requiring ArcGIS Enterprise.
 *
 * It wraps MBTiles terrain data and exposes REST endpoints that follow the
 * ArcGIS ImageServer specification expected by ArcGIS JS.
 *
 * Elevation tiles can be sourced from:
 * https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer
 *
 * Tiles can be downloaded using:
 * https://github.com/AliFlux/MapTilesDownloader
 *
 * After preparing your MBTiles file, start the server with:
 *   node index.js
 * or
 *   npm start
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from "express";
import cors from "cors";
import MBTiles from "@mapbox/mbtiles";
const PORT = 5567;



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DtedFilename="IslamabadDtedSample1-15";
// Configuration
const CONFIG = {
    port: 3001,

    // Your existing MBTiles server
    mbtilesServer: 'http://localhost:5567',
    mbtilesPath: `/tiles/${DtedFilename}`,

    // Service metadata
    serviceName: 'LocalTerrain3D',
    description: 'Locally hosted terrain elevation tiles',
    copyright: 'Downloaded from ArcGIS World Elevation'
};

let serviceExtent = null;

function lonLatToWebMercator(lon, lat) {
    const x = lon * 20037508.34 / 180;
    const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
    const yMeters = y * 20037508.34 / 180;
    return { x, y: yMeters };
}

// Tile URL format - adjust if your server uses different format
// ArcGIS expects: /tile/{level}/{row}/{col}
// Your server: /{level}/{col}/{row}
const buildTileUrl = (level, row, col) => {
    // NOTE: ArcGIS uses row/col in specific order
    // You may need to flip row/col or convert TMS coordinates
    // Try both formats below to see which works with your data

    // Option A: Direct mapping (if your server stores as {level}/{col}/{row})
    return `${CONFIG.mbtilesServer}${CONFIG.mbtilesPath}/${level}/${col}/${row}`;

    // Option B: Flipped (if tiles are stored in TMS format)
    // const tmsRow = Math.pow(2, level) - 1 - row;
    // return `${CONFIG.mbtilesServer}${CONFIG.mbtilesPath}/${level}/${col}/${tmsRow}`;
};

// ArcGIS ImageServer Service Info
const getServiceInfo = () => ({
    currentVersion: 10.81,
    serviceDescription: CONFIG.description,
    name: CONFIG.serviceName,
    description: CONFIG.description,
    copyrightText: CONFIG.copyright,
    serviceType: 'ImageServer',

    // Spatial reference (WGS84 Web Mercator - common for terrain)
    spatialReference: {
        wkid: 3857,
        latestWkid: 3857
    },

    extent: serviceExtent,
    fullExtent: serviceExtent,
    initialExtent: serviceExtent,

    // Allow tile access
    allowOrigin: '*',

    // Pixel size
    pixelSizeX: 10,
    pixelSizeY: 10,

    // Band count (1 for elevation)
    bandCount: 1,

    // Pixel type - F32 for elevation float values
    pixelType: 'F32',

    // Min/max values for elevation
    minValue: -500,
    maxValue: 9000,
    noDataValue: -9999,

    // Tile info
    tileInfo: {
        rows: 256,
        cols: 256,
        dpi: 96,
        format: 'LERC',
        compressionQuality: 0,
        origin: {
            x: -20037508.342787,
            y: 20037508.342787
        },
        spatialReference: { wkid: 3857 },
        lods: generateLODs()
    },

    // Capabilities
    capabilities: 'Image,Tile,Mensuration',
    exportTilesAllowed: false,
    maxExportTilesCount: 100000,

    // Misc properties
    mensurationCapabilities: 'Basic',
    hasHistograms: false,
    hasColormap: false,
    hasRasterAttributeTable: false,
    hasMultidimensions: false,
    serviceDataType: 'esriImageServiceDataTypeElevation',

    // Key property for elevation
    elevationSource: true,

    // Cache type
    cacheType: 'MapServer',
    defaultMosaicMethod: 'Center',
    mosaicMethods: 'Center,NorthWest,LockRaster,ByAttribute,Nadir,Viewpoint,Seamline',

    // REST endpoint info
    type: 'ImageServer',
    access: 'public'
});

// Generate Level of Details for tile pyramid
function generateLODsfull() {
    const lods = [];
    const resolutions = [
        156543.03392800014,
        78271.51696399994,
        39135.75848200009,
        19567.87924099992,
        9783.93962049996,
        4891.96981024998,
        2445.98490512499,
        1222.992452562495,
        611.4962262813797,
        305.74811314055756,
        152.87405657041106,
        76.43702828507324,
        38.21851414253662,
        19.10925707126831,
        9.554628535634155,
        4.77731426794937,
        2.388657133974685,
        1.1943285669873425,
        0.5971642834936712,
        0.2985821417468356,
        0.1492910708734178
    ];

    const scale = 591657527.591555;

    for (let i = 0; i < resolutions.length; i++) {
        lods.push({
            level: i,
            resolution: resolutions[i],
            scale: scale / Math.pow(2, i)
        });
    }

    return lods;
}


function generateLODs() {
    // Default fallback if MBTiles info isn't ready yet
    const fallback = [
        {
            level: 16,
            resolution: 0.5969000000000001,
            scale: 2259.5719099999997
        }
    ];

    if (!global.mbtilesZoomRange) return fallback;

    const [minZ, maxZ] = global.mbtilesZoomRange;
    const lods = [];

    for (let z = minZ; z <= maxZ; z++) {
        const resolution = 156543.03392804097 / Math.pow(2, z);
        const scale = resolution * 96 * 39.37; // 96 DPI, 39.37 inches per meter
        lods.push({ level: z, resolution, scale });
    }

    return lods;
}

// Proxy request to MBTiles server
const proxyTileRequest = (level, row, col, res) => {
    const tileUrl = buildTileUrl(level, row, col);

    //console.log(`Proxying tile request: ${tileUrl}`);

    const client = tileUrl.startsWith('https') ? https : http;

    const req = client.get(tileUrl, (proxyRes) => {
        if (proxyRes.statusCode === 200) {
            // Set LERC content type for elevation tiles
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400');

            proxyRes.pipe(res);
        } else {
            // Tile not found - return 404 or blank tile
            // console.log(`Tile not found: ${tileUrl} (status: ${proxyRes.statusCode})`);
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(JSON.stringify({ error: 'Tile not found' }));
        }
    });

    req.on('error', (err) => {
        console.error('Proxy error:', err.message);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ error: 'Bad gateway', message: err.message }));
    });

    req.setTimeout(30000, () => {
        req.destroy();
        res.statusCode = 504;
        res.end(JSON.stringify({ error: 'Gateway timeout' }));
    });
};

// Main request handler
const handleRequest = (req, res) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    console.log(`Request: ${req.method} ${pathname}`);

    // Service info endpoint
    if (pathname === '/arcgis/rest/services/LocalTerrain3D/ImageServer' ||
        pathname === '/arcgis/rest/services/LocalTerrain3D/ImageServer/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(getServiceInfo()));
        return;
    }

    // Tile endpoint: /arcgis/rest/services/LocalTerrain3D/ImageServer/tile/{level}/{row}/{col}
    const tileMatch = pathname.match(/\/arcgis\/rest\/services\/LocalTerrain3D\/ImageServer\/tile\/(\d+)\/(\d+)\/(\d+)/);

    if (tileMatch) {
        const level = parseInt(tileMatch[1]);
        const row = parseInt(tileMatch[2]);
        const col = parseInt(tileMatch[3]);

        proxyTileRequest(level, row, col, res);
        return;
    }

    // Alternative simpler tile endpoint for debugging
    const simpleTileMatch = pathname.match(/\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (simpleTileMatch) {
        const level = parseInt(simpleTileMatch[1]);
        const row = parseInt(simpleTileMatch[2]);
        const col = parseInt(simpleTileMatch[3]);

        proxyTileRequest(level, row, col, res);
        return;
    }

    // Service directory
    if (pathname === '/arcgis/rest/services' || pathname === '/arcgis/rest/services/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            currentVersion: 10.81,
            services: [{
                name: 'LocalTerrain3D',
                type: 'ImageServer'
            }]
        }));
        return;
    }

    // Query endpoint (simplified - returns error for now)
    if (pathname.includes('/query')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: {
                code: 400,
                message: 'Query operation not supported for offline terrain'
            }
        }));
        return;
    }

    // Health check
    if (pathname === '/health' || pathname === '/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: CONFIG.serviceName }));
        return;
    }

    // 404 for unknown endpoints
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
};

// Start server
const server = http.createServer(handleRequest);

server.listen(CONFIG.port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║       ArcGIS ImageServer API Wrapper for MBTiles               ║
╠════════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${CONFIG.port}                      ║
║                                                                ║
║  Endpoints:                                                    ║
║  • Service Info:                                               ║
║    http://localhost:${CONFIG.port}/arcgis/rest/services/LocalTerrain3D/ImageServer
║                                                                ║
║  • Tile URL format:                                            ║
║    http://localhost:${CONFIG.port}/arcgis/rest/services/LocalTerrain3D/ImageServer/tile/{level}/{row}/{col}
║                                                                ║
║  Proxying to: ${CONFIG.mbtilesServer}${CONFIG.mbtilesPath}
║  Demp Page: http://localhost:${PORT}
╚════════════════════════════════════════════════════════════════╝
  `);
});


// Create an Express server to serve files
const serverx = express();
serverx.use(cors());
serverx.listen(PORT, () => {
    console.log(`Server Now Running`);
});


const mbtilesPath = path.join("./tiles/", `${DtedFilename}.mbtiles`,);

new MBTiles(`${mbtilesPath}?mode=ro`, (err, mbtiles) => {
    if (err) return;

    mbtiles.getInfo((infoErr, info) => {
        if (!infoErr && info.bounds) {
            const [minLon, minLat, maxLon, maxLat] = info.bounds;

            const min = lonLatToWebMercator(minLon, minLat);
            const max = lonLatToWebMercator(maxLon, maxLat);

            serviceExtent = {
                xmin: min.x,
                ymin: min.y,
                xmax: max.x,
                ymax: max.y,
                spatialReference: { wkid: 3857 }
            };

            console.log("✅ Auto extent loaded:", serviceExtent);
            global.mbtilesZoomRange = [info.minzoom, info.maxzoom];
            console.log("✅ Auto extent & LOD range loaded:", global.mbtilesZoomRange);
        }
    });
});

// Folder where your .mbtiles files are stored
const mbtilesDirectory = "./tiles/";


serverx.get("/tiles/:fileName/:level/:col/:row", (req, res) => {
    const { fileName, level, col, row } = req.params;
    const mbtilesPath = path.join(mbtilesDirectory, `${fileName}.mbtiles`);
    console.log(mbtilesPath);

    new MBTiles(`${mbtilesPath}?mode=ro`, (err, mbtiles) => {
        if (err) {
            console.error("Error opening mbtiles file:", err);
            res.status(500).send("Failed to open mbtiles file");
            return;
        }

        mbtiles.getInfo((infoErr, info) => {
            if (!infoErr && info.bounds && info.minzoom != null && info.maxzoom != null) {
                const [minLon, minLat, maxLon, maxLat] = info.bounds;
                const min = lonLatToWebMercator(minLon, minLat);
                const max = lonLatToWebMercator(maxLon, maxLat);

                serviceExtent = {
                    xmin: min.x,
                    ymin: min.y,
                    xmax: max.x,
                    ymax: max.y,
                    spatialReference: { wkid: 3857 }
                };             
            }
        });


        mbtiles.getTile(level, col, row, (tileErr, tile, headers) => {
            if (tileErr) {
                // console.error('Tile not found:', tileErr);
                res.status(404).send("Tile not found");
            } else {
                res.set(headers);
                res.send(tile);
            }
        });
    });
});

serverx.use(express.static(__dirname));

// Option B: Explicitly serve just the index.html file
// serverx.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, 'index.html'));
// });
