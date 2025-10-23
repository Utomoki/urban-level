"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";

type UrbanLevel = { label: string; tone: "neutral" | "amber" | "green"; desc: string };

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function fetchWithTimeout(input: RequestInfo, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 25000, ...rest } = init;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...rest, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

async function fetchOverpass(query: string) {
  let lastErr: any = null;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = `${OVERPASS_ENDPOINTS[i]}?data=${encodeURIComponent(query)}`;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 25000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      // 軽いバックオフ
      await new Promise((r) => setTimeout(r, 150 * (i + 1) ** 2));
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
}

export default function Home() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);

  const [radius, setRadius] = useState<500 | 1000 | 3000>(1000);
  const [query, setQuery] = useState("");
  const [center, setCenter] = useState<[number, number] | null>(null); // [lng, lat]

  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState("地名を検索するか、地図をクリックして中心点を選んでください。");
  const [error, setError] = useState<string>("");
  const [stats, setStats] = useState<{
    areaKm2: number;
    poiCount: number;
    poiDensity: number;
    urbanLevel: UrbanLevel;
  } | null>(null);

  const CIRCLE_SRC_ID = "selected-circle";
  const CIRCLE_FILL_ID = "selected-circle-fill";
  const CIRCLE_LINE_ID = "selected-circle-line";

  const MAPTILER_KEY =
    process.env.NEXT_PUBLIC_MAPTILER_KEY || "YOUR_MAPTILER_KEY";

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`,
      center: [139.7671, 35.6812],
      zoom: 11,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource(CIRCLE_SRC_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: CIRCLE_FILL_ID,
        type: "fill",
        source: CIRCLE_SRC_ID,
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: CIRCLE_LINE_ID,
        type: "line",
        source: CIRCLE_SRC_ID,
        paint: { "line-color": "#2563eb", "line-width": 2 },
      });

      // クリックで中心設定
      map.on("click", (e) => {
        setPointAndDraw([e.lngLat.lng, e.lngLat.lat], true);
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, [MAPTILER_KEY]);

  // 半径変更時に円だけ更新
  useEffect(() => {
    if (center) drawCircle(center, radius);
  }, [radius]);

  // ---- 検索（MapTiler Geocoding） ----
  async function geocodeAndMove() {
    if (!query.trim()) return;
    try {
      setError("");
      setHint("検索中…");
      const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(
        query
      )}.json?key=${MAPTILER_KEY}&language=ja&limit=1`;
      const res = await fetchWithTimeout(url, { timeoutMs: 15000 });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error("MapTilerのAPIキーが無効か権限制限です。.env.local を確認してサーバを再起動してください。");
        }
        throw new Error(`Geocoding error: ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      const f = json?.features?.[0];
      if (!f?.center) throw new Error("場所が見つかりませんでした。別の地名でお試しください。");
      setPointAndDraw([f.center[0], f.center[1]], true);
      setHint("中心点をセットしました。半径を選んで「計算」を押してください。");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  // ---- 中心セット & 円描画 & マーカー配置 ----
  function setPointAndDraw(lnglat: [number, number], fit = false) {
    setError("");
    setStats(null);
    setCenter(lnglat);
    drawCircle(lnglat, radius);
    placeOrMoveMarker(lnglat, fit);
    if (fit) fitToCircle(lnglat, radius);
  }

  function placeOrMoveMarker(lnglat: [number, number], fit = false) {
    const map = mapRef.current!;
    if (!centerMarkerRef.current) {
      // ★ ドラッグ可能なマーカーに変更：ドラッグで中心更新＋円を追従
      centerMarkerRef.current = new maplibregl.Marker({ color: "#2563eb", draggable: true })
        .setLngLat(lnglat)
        .addTo(map);

      centerMarkerRef.current.on("drag", () => {
        const pos = centerMarkerRef.current!.getLngLat();
        const ll: [number, number] = [pos.lng, pos.lat];
        setCenter(ll);
        drawCircle(ll, radius); // ドラッグ中も円を追従
      });

      centerMarkerRef.current.on("dragend", () => {
        const pos = centerMarkerRef.current!.getLngLat();
        const ll: [number, number] = [pos.lng, pos.lat];
        setCenter(ll);
        drawCircle(ll, radius);
      });
    } else {
      centerMarkerRef.current.setLngLat(lnglat);
    }
  }

  function drawCircle(lnglat: [number, number], rMeters: number) {
    const map = mapRef.current;
    if (!map) return;
    const circle = turf.circle(lnglat, rMeters, { steps: 128, units: "meters" });
    const src = map.getSource(CIRCLE_SRC_ID) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(circle as any);
  }

  function fitToCircle(lnglat: [number, number], rMeters: number) {
    const map = mapRef.current!;
    const circle = turf.circle(lnglat, rMeters, { steps: 128, units: "meters" });
    const bbox = turf.bbox(circle);
    map.fitBounds(bbox as [number, number, number, number], { padding: 60, duration: 500 });
  }

  // ---- 計算（Overpass フェイルオーバー + タイムアウト） ----
  async function handleCalculate() {
    if (!center) {
      setError("先に中心点を設定してください（検索・クリック・ピンドラッグ）。");
      return;
    }
    setError("");
    setHint("");
    setStats(null);
    setLoading(true);
    try {
      const circle = turf.circle(center, radius, { steps: 128, units: "meters" }) as turf.helpers.Feature<turf.helpers.Polygon>;
      const areaM2 = turf.area(circle);
      const areaKm2 = areaM2 / 1_000_000;

      const [lng, lat] = center;
      const r = radius; // 500 / 1000 / 3000

      const query = `
        [out:json][timeout:25];
        (
          node[amenity](around:${r},${lat},${lng});
          node[shop](around:${r},${lat},${lng});
          node[office](around:${r},${lat},${lng});
          node[public_transport](around:${r},${lat},${lng});
        );
        out center qt;
      `;
      // ★ ここが “failed to fetch” の起点になりやすいので、ミラーで再試行
      const json = await fetchOverpass(query);

      let count = 0;
      for (const el of json.elements ?? []) {
        if (el.type === "node") {
          const pt = turf.point([el.lon, el.lat]);
          if (turf.booleanPointInPolygon(pt, circle)) count += 1;
        }
      }

      const density = count / Math.max(areaKm2, 1e-6);
      const urbanLevel = classifyUrbanLevel(density);
      setStats({ areaKm2, poiCount: count, poiDensity: density, urbanLevel });
    } catch (e: any) {
      // ネットワーク系の典型パターンを少し親切に
      const msg = String(e?.message ?? e);
      if (msg.includes("Failed to fetch") || msg.includes("fetch")) {
        setError("ネットワークまたはCORSで取得に失敗しました。少し待って再実行するか、半径を小さくしてください。");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  function classifyUrbanLevel(density: number): UrbanLevel {
    if (density < 5)   return { label: "低（Rural）",   tone: "neutral", desc: "生活施設が少なく疎なエリア" };
    if (density < 20)  return { label: "中（Suburban）", tone: "amber",   desc: "郊外～準都心レベルの密度" };
    return                { label: "高（Urban）",        tone: "green",   desc: "商業・公共施設が密な都心レベル" };
  }

  const Badge = ({ tone, children }: { tone: UrbanLevel["tone"]; children: React.ReactNode }) => {
    const styles =
      tone === "green" ? "bg-green-100 text-green-700" :
      tone === "amber" ? "bg-amber-100 text-amber-700" :
                         "bg-gray-100 text-gray-700";
    return <span className={`inline-block px-2 py-1 rounded-full text-xs ${styles}`}>{children}</span>;
  };

  function resetAll() {
    setStats(null);
    setError("");
    setHint("地名を検索するか、地図をクリックして中心点を選んでください。");
    setCenter(null);
    const map = mapRef.current;
    if (map) {
      const src = map.getSource(CIRCLE_SRC_ID) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: [] } as any);
    }
    if (centerMarkerRef.current) {
      centerMarkerRef.current.remove();
      centerMarkerRef.current = null;
    }
  }

  return (
    <main className="min-h-screen p-0">
      {/* 地図 */}
      <div ref={containerRef} className="h-[80vh] w-full relative" />

      {/* 左上パネル */}
      <div className="absolute top-4 left-4 bg-white/90 backdrop-blur p-4 rounded-xl shadow space-y-3 text-sm max-w-md">
        <div className="font-semibold">都市レベル推定（円範囲）</div>

        {/* 検索 */}
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && geocodeAndMove()}
            className="flex-1 rounded border px-2 py-1"
            placeholder="地名を入力（例：吉祥寺、札幌駅）"
          />
          <button
            onClick={geocodeAndMove}
            className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            title="検索"
          >
            検索
          </button>
        </div>

        {/* 半径選択 */}
        <div className="flex items-center gap-3">
          <span className="text-gray-600">半径:</span>
          {[500, 1000, 3000].map((r) => (
            <label key={r} className="flex items-center gap-1">
              <input
                type="radio"
                name="radius"
                value={r}
                checked={radius === r}
                onChange={() => setRadius(r as 500 | 1000 | 3000)}
              />
              <span>{r.toLocaleString()} m</span>
            </label>
          ))}
        </div>

        {/* アクション */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleCalculate}
            disabled={!center || loading}
            className="px-3 py-1 rounded bg-emerald-600 text-white disabled:opacity-50 hover:bg-emerald-700"
            title="選択した円の都市レベルを計算"
          >
            計算
          </button>
          <button
            onClick={resetAll}
            className="px-2 py-1 rounded border hover:bg-gray-50"
            title="中心点と結果をクリア"
          >
            クリア
          </button>
        </div>

        {hint && <div className="text-gray-600">{hint}</div>}
        {loading && <div className="text-gray-700">計算中…（数秒かかることがあります）</div>}
        {error && <div className="text-red-700">エラー：{error}</div>}
      </div>

      {/* 右下：結果パネル */}
      {stats && !loading && !error && (
        <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur p-4 rounded-xl shadow text-sm">
          <div className="flex items-center gap-2 mb-2">
            <Badge tone={stats.urbanLevel.tone}>都市レベル：{stats.urbanLevel.label}</Badge>
            <span className="text-gray-600">{stats.urbanLevel.desc}</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-gray-500">範囲面積</div>
              <div className="text-lg font-semibold">{stats.areaKm2.toFixed(2)} km²</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">POI件数</div>
              <div className="text-lg font-semibold">{stats.poiCount.toLocaleString()} 件</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">POI密度</div>
              <div className="text-lg font-semibold">{stats.poiDensity.toFixed(1)} / km²</div>
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-2">
            ※ OSM密度の試作推定です。混雑や広すぎる範囲で失敗することがあります。
          </div>
        </div>
      )}
    </main>
  );
}
