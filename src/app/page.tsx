"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import * as turf from "@turf/turf";

type UrbanLevel = { label: string; tone: "neutral" | "amber" | "green"; desc: string };

export default function Home() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [stats, setStats] = useState<{
    areaKm2: number;
    poiCount: number;
    poiDensity: number;
    urbanLevel: UrbanLevel;
  } | null>(null);

  const MAPTILER_KEY =
    process.env.NEXT_PUBLIC_MAPTILER_KEY || "YOUR_MAPTILER_KEY";

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Mapbox Draw が参照するグローバルに MapLibre を結びつけ
    (window as any).mapboxgl = maplibregl;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`,
      center: [139.7671, 35.6812],
      zoom: 11,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: { polygon: true, trash: true },
        styles: [
          { // ポリゴン塗り
            id: "gl-draw-polygon-fill",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
            paint: { "fill-color": "#2563eb", "fill-opacity": 0.15 },
          },
          { // ポリゴン線
            id: "gl-draw-polygon-stroke-active",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
            paint: { "line-color": "#2563eb", "line-width": 2 },
          },
          { // 頂点
            id: "gl-draw-polygon-and-line-vertex-halo-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
            paint: { "circle-radius": 5, "circle-color": "#ffffff" },
          },
          {
            id: "gl-draw-polygon-and-line-vertex-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
            paint: { "circle-radius": 3, "circle-color": "#2563eb" },
          },
        ],
      });

      map.addControl(draw, "top-left");

      const onUpdate = async () => {
        const data = draw.getAll();
        if (!data || !data.features.length) {
          setStats(null);
          return;
        }
        const poly = data.features[data.features.length - 1]; // 最後に描いたポリゴン
        try {
          await analyzePolygon(poly);
        } catch (e: any) {
          setError(e?.message ?? String(e));
        }
      };

      map.on("draw.create", onUpdate);
      map.on("draw.update", onUpdate);
      map.on("draw.delete", () => {
        setStats(null);
        setError("");
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, [MAPTILER_KEY]);

  // --- 都市レベル判定（暫定しきい値）はあとで調整OK ---
  function classifyUrbanLevel(density: number): UrbanLevel {
    if (density < 5)   return { label: "低（Rural）",   tone: "neutral", desc: "生活施設が少なく疎なエリア" };
    if (density < 20)  return { label: "中（Suburban）", tone: "amber",   desc: "郊外～準都心レベルの密度" };
    return                { label: "高（Urban）",    tone: "green",   desc: "商業・公共施設が密な都心レベル" };
  }

  async function analyzePolygon(poly: any) {
    setError("");
    setLoading(true);
    try {
      const areaM2 = turf.area(poly);
      const areaKm2 = areaM2 / 1_000_000;

      // Overpass は (lat lon) 順の頂点列を期待
      const coordsLatLon = poly.geometry.coordinates[0]
        .map((c: number[]) => `${c[1]} ${c[0]}`)
        .join(" ");

      const query = `
        [out:json][timeout:25];
        (
          node[amenity](poly:"${coordsLatLon}");
          way[amenity](poly:"${coordsLatLon}");
          relation[amenity](poly:"${coordsLatLon}");
          node[shop](poly:"${coordsLatLon}");
          way[shop](poly:"${coordsLatLon}");
          relation[shop](poly:"${coordsLatLon}");
          node[office](poly:"${coordsLatLon}");
          way[office](poly:"${coordsLatLon}");
          relation[office](poly:"${coordsLatLon}");
          node[public_transport](poly:"${coordsLatLon}");
          way[public_transport](poly:"${coordsLatLon}");
          relation[public_transport](poly:"${coordsLatLon}");
        );
        out center qt;`;

      const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
      const json = await res.json();

      // ポリゴン内にあるPOIを数える（way/relation は center を使用）
      const polygon = turf.polygon(poly.geometry.coordinates);
      let count = 0;
      for (const el of json.elements ?? []) {
        let pt: turf.helpers.Point | undefined;
        if (el.type === "node") pt = turf.point([el.lon, el.lat]);
        if ((el.type === "way" || el.type === "relation") && el.center)
          pt = turf.point([el.center.lon, el.center.lat]);
        if (pt && turf.booleanPointInPolygon(pt, polygon)) count += 1;
      }

      const density = count / Math.max(areaKm2, 1e-6); // POI / km²
      const urbanLevel = classifyUrbanLevel(density);

      setStats({
        areaKm2: areaKm2,
        poiCount: count,
        poiDensity: density,
        urbanLevel,
      });
    } finally {
      setLoading(false);
    }
  }

  // UI の小さな部品
  const Badge = ({ tone, children }: { tone: UrbanLevel["tone"]; children: React.ReactNode }) => {
    const styles =
      tone === "green" ? "bg-green-100 text-green-700" :
      tone === "amber" ? "bg-amber-100 text-amber-700" :
                         "bg-gray-100 text-gray-700";
    return <span className={`inline-block px-2 py-1 rounded-full text-xs ${styles}`}>{children}</span>;
  };
  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );

  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">都市レベルテスト（POI密度 → 推定）</h1>
      <div ref={containerRef} className="h-[72vh] w-full rounded-xl shadow border relative" />

      {/* パネル */}
      <div className="mt-4">
        {!stats && !loading && !error && (
          <div className="text-gray-700">
            左上の<strong>Polygon</strong>で範囲を描くと、OSMの <code>amenity/shop/office/public_transport</code> を
            取得して密度を計算します（試作版）。
          </div>
        )}
        {loading && <div className="text-gray-700">計算中…（数秒かかることがあります）</div>}
        {error && <div className="text-red-700">エラー：{error}</div>}
        {stats && !loading && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <Badge tone={stats.urbanLevel.tone}>都市レベル：{stats.urbanLevel.label}</Badge>
              <span className="text-gray-600">{stats.urbanLevel.desc}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Stat label="範囲面積" value={`${stats.areaKm2.toFixed(2)} km²`} />
              <Stat label="POI件数" value={`${stats.poiCount.toLocaleString()} 件`} />
              <Stat label="POI密度" value={`${stats.poiDensity.toFixed(1)} / km²`} />
            </div>
            <div className="text-xs text-gray-500">
              ※ しきい値は暫定。あとで人口密度・駅アクセスなどの指標に置き換え可能です。
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
