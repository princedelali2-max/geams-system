/* GEAMS map helper (loaded right after Leaflet).
 * 1. Reads /config.js so an agency can point the map pictures at its own tile server.
 * 2. Tells the user plainly when map pictures cannot be loaded, instead of leaving a blank grey map. Pins, routes and positions keep working. */
(function () {
  if (typeof L === 'undefined' || !L.tileLayer || L.__geamsPatched) return; L.__geamsPatched = true;
  var cfg = window.GEAMS_CONFIG || {}, orig = L.tileLayer;
  function note(map) {
    if (!map || map.__geamsTileNote) return; var c = map.getContainer && map.getContainer(); if (!c) return;
    var d = document.createElement('div'); d.className = 'geams-tile-note';
    d.style.cssText = 'position:absolute;left:8px;bottom:26px;z-index:900;max-width:80%;padding:5px 9px;border-radius:6px;background:rgba(20,24,32,.88);color:#ffd27a;font:600 11px/1.35 system-ui,sans-serif;pointer-events:none;border:1px solid rgba(255,210,122,.4)';
    d.textContent = 'Map pictures cannot be loaded right now (no connection to the map service). Positions, pins and routes still work.';
    c.appendChild(d); map.__geamsTileNote = d;
  }
  L.tileLayer = function (url, opts) {
    if (cfg.tileUrl && /arcgisonline\.com|tile\.openstreetmap\.org/.test(url)) { url = cfg.tileUrl; opts = Object.assign({}, opts, cfg.tileAttribution ? { attribution: cfg.tileAttribution } : {}); }
    // Esri satellite pictures stop at a fixed detail level that is lower in many parts of Ghana; past it the server sends grey "map data not yet available" tiles.
    // Stop asking for detail beyond that level and stretch the last real picture instead (set tileMaxNativeZoom in config.js to change it).
    if (/World_Imagery/.test(url) && !cfg.tileUrl) opts = Object.assign({}, opts, { maxNativeZoom: Math.min(opts && opts.maxZoom || 19, cfg.tileMaxNativeZoom || 16) });
    // OpenStreetMap (and most self-hosted tile servers) refuse tile requests that carry no Referer ("403 Access blocked", their tile usage policy). The apps send none
    // by default for privacy, so tile pictures from these hosts send only this site's address (never the page, user or incident), and Esri pictures still send nothing.
    if (!/arcgisonline\.com/.test(url)) opts = Object.assign({}, opts, { referrerPolicy: 'origin' });
    var layer = orig.call(L, url, opts), bad = 0, good = 0;
    layer.on('tileload', function () { good++; if (good === 1 && layer._map && layer._map.__geamsTileNote) { layer._map.__geamsTileNote.remove(); layer._map.__geamsTileNote = null; } });
    var imagery = /World_Imagery/.test(url) && !cfg.tileUrl, fell = false;
    layer.on('tileerror', function () {
      bad++;
      if (bad >= 3 && good === 0) {
        // satellite pictures are blocked or unreachable: try the plain OpenStreetMap map before giving up
        if (imagery && !fell) { fell = true; bad = 0; try { layer.options.attribution = '&copy; OpenStreetMap contributors'; layer.options.referrerPolicy = 'origin'; layer.setUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png'); if (layer._map && layer._map.attributionControl) layer._map.attributionControl.addAttribution('&copy; OpenStreetMap contributors'); } catch (e) {} return; }
        note(layer._map);
      }
    });
    // tiles that never answer (blocked, very slow link) produce no error at all: say so after 12 s instead of leaving a grey map
    layer.on('add', function () { setTimeout(function () { if (good === 0 && layer._map && layer._map.hasLayer(layer)) note(layer._map); }, 12000); });
    return layer;
  };
})();
