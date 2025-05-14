/* ────────────────────────────────────────────────────────── */
/*  GLOBALS & HELPERS                                       */
/* ────────────────────────────────────────────────────────── */
const CSV_URL    = "data.csv",
      GEO_URL    = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

const pcpResetBtn = document.getElementById("reset-pcp"),
      mapResetBtn = document.getElementById("reset-map");

const resetScatterBtn = document.getElementById("reset-scatter");
      let activeScatterFips = new Set();  // ← holds FIPS codes in the current 2D‐brush
      let scatterBrush;                   // ← reference to the D3 brush so we can clear it
      

const mapHolder   = d3.select("#choropleth"),
      pcaHolder   = d3.select("#pca-biplot"),
      pcpHolder   = d3.select("#pcp-plot"),
      donutHolder = d3.select("#donut-chart"),
      scatterSelect  = d3.select("#scatter-select"),
      scatterHolder  = d3.select("#scatterplot");

// shared state
let rows                = [],
    stateOfFips         = new Map(),
    stateRegion         = new Map(),
    activeState         = null,
    clusterOfFips       = new Map(),
    topAxes             = [],      // [{col, short}, ...]
    globalBrushes       = [],      // for PCP reset
    updatePCPVisibility = () => {}; // placeholder

let activeRegion       = null,   // ← NEW
  selectionMode      = 'state';// ← NEW: 'state' or 'region'

// ─── which field to color the map by: AvgScore | Wellbeing_Score ───
let mapMetric = 'AvgScore';

const metricLabels = {
  AvgScore:      'Avg Score',
  Wellbeing_Score: 'Wellbeing Score'
};


let clusterColour;  // set after PCA

let activeDonut     = null;     // which slice is clicked
let donutMeans      = new Map();
const eduCols = {               // same keys as in drawDonut()
  SomeCollege: "Percent of adults completing some college or associate degree, 2019-23",
  HSGrad:      "Percent of adults who are high school graduates (or equivalent), 2019-23",
  NoHSGrad:    "Percent of adults who are not high school graduates, 2019-23",
  "Bachelors+": "Percent of adults with a bachelor's degree or higher, 2019-23"
};

// keep track of which clusters are checked in the legend
let selectedClusters = new Set();

// track the latest PCP axis‐brush ranges for the map filter
let activePCPBrushes = new Map();

// do this instead:
const palette = ["#e41a1c","#984ea3","#ff7f00","#a65628","#f781bf"]; // whatever you like
const uniqueRegions = Array.from(new Set(rows.map(r => r.Region)));
const regionColour = {};
uniqueRegions.forEach((reg,i) => {
  regionColour[reg] = palette[i % palette.length];
});


const choroplethCol = d3.scaleSequential(d3.interpolateBlues);

// helper to pick the right interpolator
function setInterpolator() {
  if (mapMetric === "AvgScore") {
    choroplethCol.interpolator(d3.interpolateBlues);
  } else {
    choroplethCol.interpolator(d3.interpolateGreens);
  }
}



/* ────────────────────────────────────────────────────────── */
/*  LOAD & INITIALIZE                                       */
/* ────────────────────────────────────────────────────────── */
Promise.all([
  d3.csv(CSV_URL, d3.autoType),
  d3.json(GEO_URL)
]).then(([dataCsv, topo])=>{
  // compute AvgScore & build lookups
  rows = dataCsv.map(r=>({
    ...r,
    AvgScore: (r.Anxiety_Score_2020 + r.Depression_Score_2020)/2
  }));
  rows.forEach(r=>{
    stateOfFips.set(r.FIPS_Code, r.State_Name);
    stateRegion.set(r.State_Name, r.Region);
  });
  // new: base the domain on whichever metric is selected
setInterpolator();
choroplethCol.domain(d3.extent(rows, d => d[mapMetric]));


  // NEW: toggle between state vs. region selection
  d3.selectAll('input[name="map-mode"]').on('change', function() {
    selectionMode = this.value;      // 'state' or 'region'
    activeState  = null;            // clear the other filter
    activeRegion = null;
    updateMapVisibility();
    drawDonut();
    updatePCPVisibility();
    drawScatter();
  });

  // after rows, stateOfFips, stateRegion are populated…
  const palette       = ["#e41a1c","#984ea3","#ff7f00","#a65628","#f781bf"];
  const uniqueRegions = Array.from(new Set(rows.map(r => r.Region)));
  const regionColour  = {};
  uniqueRegions.forEach((reg,i) => {
    regionColour[reg] = palette[i % palette.length];
  });

  // then
  drawMap(topo, regionColour, uniqueRegions);

  drawPCA();

  resetScatterBtn.addEventListener("click", () => {
    // clear the visual brush
    d3.select(".scatter-brush").call(scatterBrush.move, null);
    // clear our FIPS set
    activeScatterFips.clear();
    // undim all scatter points
    scatterHolder.selectAll("circle").classed("dim", false);
    // propagate reset to map, PCP & donut
    updateMapVisibility();
    updatePCPVisibility();
    drawDonut();
  });
  
  // ──────────────────────────────────────────────────────────
  //  Choropleth “Reset” — clear only map filters
  // ──────────────────────────────────────────────────────────
  mapResetBtn.addEventListener("click", () => {
  activeState  = null;
  activeRegion = null;
  updateMapVisibility();
  // drawPCA();
  // drawDonut();
  // updatePCPVisibility();
  // drawScatter();
  });
});


/* ────────────────────────────────────────────────────────── */
/*  DRAW CHOROPLETH                                         */
/* ────────────────────────────────────────────────────────── */
function drawMap(topo, regionColour, uniqueRegions) {
  // clear out any previous map
  mapHolder.selectAll("*").remove();

  const W = mapHolder.node().clientWidth,
        H = mapHolder.node().clientHeight;

  // projection + path
  const projection = d3.geoAlbersUsa()
        .fitSize([W, H], topojson.feature(topo, topo.objects.counties));
  const path = d3.geoPath(projection);

  // svg container
  const svg = mapHolder.append("svg")
               .attr("viewBox", `0 0 ${W} ${H}`);

  // ── counties ──────────────────────────────────────────────
  svg.append("g").attr("class", "counties")
    .selectAll("path")
    .data(topojson.feature(topo, topo.objects.counties).features)
    .join("path")
      .attr("d", path)
      .attr("fill", d => {
        const r = rows.find(r => r.FIPS_Code === +d.id);
        if (!r) return "#f4a261";            // no data
        if (r[mapMetric] == null) return "#ccc"; // null metric
        return choroplethCol(r[mapMetric]);
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.25)
      .attr("cursor", "pointer")
      .on("click", (_, d) => {
        const fips = +d.id,
              st   = stateOfFips.get(fips);
        if (selectionMode === 'state') {
          activeState  = (activeState === st ? null : st);
          activeRegion = null;
        } else {
          const reg = stateRegion.get(st);
          activeRegion = (activeRegion === reg ? null : reg);
          activeState  = null;
        }
        updateMapVisibility();
        drawDonut();
        updatePCPVisibility();
        drawScatter();
      })
    .append("title")
      .text(d => {
        const f   = +d.id,
              st  = stateOfFips.get(f) || "Unknown",
              rg  = stateRegion.get(st)   || "Unknown",
              val = rows.find(r=>r.FIPS_Code===f)?.[mapMetric];
        return `${st}\n${rg}\n${metricLabels[mapMetric]}: ${val}`;
      });

  // ── state outlines (colored by region) ────────────────────
  svg.append("g").attr("class","states")
    .selectAll("path")
    .data(topojson.feature(topo, topo.objects.states).features)
    .join("path")
      .attr("d", path)
      .attr("fill", "none")
      .attr("stroke", d => {
        const reg = stateRegion.get(d.properties.name);
        return regionColour[reg] || "#ccc";
      })
      .attr("stroke-width", 2);

    // ── invisible click‐layer so you can click anywhere in a state ──
    svg.append("g").attr("class","state-click-layer")
    .selectAll("path")
    .data(topojson.feature(topo, topo.objects.states).features)
    .join("path")
      .attr("d", path)
      .attr("fill", "none")              // ← changed from "transparent"
      .attr("pointer-events", "stroke")  // ← changed from "all"
      .attr("cursor", "pointer")
      .on("click", (event,d) => {
        const st = d.properties.name;
        if (selectionMode === 'state') {
          activeState  = (activeState === st ? null : st);
          activeRegion = null;
        } else {
          const reg = stateRegion.get(st);
          activeRegion = (activeRegion === reg ? null : reg);
          activeState  = null;
        }
        updateMapVisibility();
        drawDonut();
        updatePCPVisibility();
        drawScatter();
      });

  // ── color‐bar legend for your metric ───────────────────────
  makeMetricLegend(svg, W, H);

  // ── **re-hook** the metric dropdown so AvgScore ↔ Wellbeing_Score still works
  d3.select("#choropleth-select").on("change", function() {
    mapMetric = this.value;
    // 1) update our interpolator & domain
    setInterpolator();
    choroplethCol.domain(d3.extent(rows, d => d[mapMetric]));

    // 2) rebuild the color‐bar
    svg.select("defs").remove();
    d3.select("#metric-legend").remove();
    makeMetricLegend(svg, W, H);

    // 3) recolor every county (preserving any dimming)
    svg.selectAll(".counties path")
      .attr("fill", d => {
        const r = rows.find(r => r.FIPS_Code === +d.id);
        if (!r) return "#f4a261";
        if (r[mapMetric] == null) return "#ccc";
        return choroplethCol(r[mapMetric]);
      })
      .select("title")
        .text(d => {
          const f   = +d.id,
                st  = stateOfFips.get(f) || "Unknown",
                rg  = stateRegion.get(st)   || "Unknown",
                val = rows.find(r=>r.FIPS_Code===f)?.[mapMetric];
          return `${st}\n${rg}\n${metricLabels[mapMetric]}: ${val}`;
    });
 });

  // ── region legend ─────────────────────────────────────────
  const regionLegend = d3.select("#choropleth-container")
    .append("div")
      .attr("class","region-legend")
      .style("position",      "absolute")
      .style("top",           "5rem")
      .style("right",         "3rem")
      .style("background",    "rgba(255,255,255,0.9)")
      .style("padding",       "0.5rem")
      .style("border-radius","4px")
      .style("font-size",     ".8rem")
      .style("pointer-events","none");

  uniqueRegions.forEach(reg => {
    const col = regionColour[reg];
    const item = regionLegend.append("div")
      .style("display",       "flex")
      .style("align-items",   "center")
      .style("margin-bottom", "4px");
    item.append("span")
      .style("display",       "inline-block")
      .style("width",         "12px")
      .style("height",        "12px")
      .style("background",    col)
      .style("margin-right",  "6px");
    item.append("span").text(reg);
  });

  // ── updateMapVisibility (unchanged) ───────────────────────
  updateMapVisibility = () => {
    svg.selectAll(".counties path")
      .classed("dim", d => {
        const fips = +d.id,
              r    = rows.find(r=>r.FIPS_Code===fips),
              st   = stateOfFips.get(fips),
              cl   = clusterOfFips.get(fips);

        if (!selectedClusters.has(cl)) return true;
        if (activeState   && st   !== activeState) return true;
        if (activeRegion  && stateRegion.get(st) !== activeRegion) return true;
        for (const [col,[mn,mx]] of activePCPBrushes) {
          if (r[col] < mn || r[col] > mx) return true;
        }
        if (activeScatterFips.size && !activeScatterFips.has(fips)) return true;
        if (activeDonut) {
          const thresh = donutMeans.get(activeDonut),
                col    = eduCols[activeDonut];
          if (r[col] < thresh) return true;
        }
        return false;
      });

    svg.selectAll(".states path")
      .classed("dim", d => {
        if (selectionMode === 'state') {
          return activeState && d.properties.name !== activeState;
        } else {
          return activeRegion && stateRegion.get(d.properties.name) !== activeRegion;
        }
      });
  };

  // ── initial render ────────────────────────────────────────
  updateMapVisibility();
}


function drawPCA() {
  // clear out old biplot
  pcaHolder.selectAll("*").remove();

  // fetch new PCA results
  d3.json("/pca").then(({ k, points: rawPoints, loadings, top_vars, avg_loading, hist_vars }) => {
    // ──────────────────────────────────────────────────────────
    // 0) drop the single extreme outlier on PC1
    // ──────────────────────────────────────────────────────────
    const maxPC1 = d3.max(rawPoints, d => d.pc1);
    const points = rawPoints.filter(d => d.pc1 < maxPC1);

    // ──────────────────────────────────────────────────────────
    // 1) clustering setup (use rawPoints so filtering doesn’t break map/PCP)
    // ──────────────────────────────────────────────────────────
    clusterOfFips = new Map(rawPoints.map(p => [p.fips, p.cluster]));
    const clusterPalette = ["#9467bd", "#8c564b", "#e377c2" /*, … more if k>3 */];
    clusterColour = d3.scaleOrdinal()
                    .domain(d3.range(k))
                    .range(clusterPalette);

    // ──────────────────────────────────────────────────────────
    // 2) prepare rows & axes list
    // ──────────────────────────────────────────────────────────
    top_vars.forEach(v => {
      rows.forEach(r => { r[v.short] = r[v.full]; });
    });
    topAxes = [
      { col: "AvgScore", short: "AvgScore", full: "AvgScore" },
      ...top_vars.map(v => ({ col: v.short, short: v.short, full: v.full }))
    ];

    // ──────────────────────────────────────────────────────────
    // Populate scatterplot dropdown & wire change → drawScatter
    // ──────────────────────────────────────────────────────────
    scatterSelect.selectAll("option").remove();
    topAxes.filter(ax => ax.col !== 'AvgScore').forEach(ax => {
      scatterSelect.append("option")
      .attr("value", ax.col)
      .text(ax.short);
    });
    scatterSelect.on("change", drawScatter);


    // ──────────────────────────────────────────────────────────
    // 4) draw & wire up PCP first (for cross‐linking)
    // ──────────────────────────────────────────────────────────
    drawPCP();
    pcpResetBtn.onclick = () => {
      globalBrushes.forEach(({ g, brush }) => g.call(brush.move, null));
      activePCPBrushes.clear();
      updatePCPVisibility();
    };
    // ──────────────────────────────────────────────────────────
    // 5) compute dynamic scales to fit filtered points
    // ──────────────────────────────────────────────────────────
    const W = pcaHolder.node().clientWidth,
          H = pcaHolder.node().clientHeight,
          m = { top:18, right:12, bottom:28, left:34 },
          w = W - m.left - m.right,
          h = H - m.top - m.bottom;

    // find min/max from the *filtered* points
    const xVals = points.map(d => d.pc1),
          yVals = points.map(d => d.pc2);
    const xMin = d3.min(xVals), xMax = d3.max(xVals),
          yMin = d3.min(yVals), yMax = d3.max(yVals);
    const xPad = (xMax - xMin) * 0.05,
          yPad = (yMax - yMin) * 0.05;

    const x = d3.scaleLinear([xMin - xPad-0.2, xMax + xPad], [0, w]),
          y = d3.scaleLinear([yMin - yPad-0.1, yMax + yPad+0.1], [h, 0]);

    // ──────────────────────────────────────────────────────────
    // 6) set up SVG, grid‐lines & axes
    // ──────────────────────────────────────────────────────────
    const svg = pcaHolder.append("svg")
                 .attr("viewBox", `0 0 ${W} ${H}`);
    const g   = svg.append("g")
                 .attr("transform", `translate(${m.left},${m.top})`);

    // horizontal grid‐lines
    const yTicks = y.ticks(5);
    g.append("g").selectAll("line")
      .data(yTicks).join("line")
        .attr("class", "grid-line")
        .attr("x1", 0).attr("x2", w)
        .attr("y1", d => y(d)).attr("y2", d => y(d));
    // vertical grid‐lines
    const xTicks = x.ticks(5);
    g.append("g").selectAll("line")
      .data(xTicks).join("line")
        .attr("class", "grid-line")
        .attr("y1", 0).attr("y2", h)
        .attr("x1", d => x(d)).attr("x2", d => x(d));

    // axes
    g.append("g")
      .attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(5));
    g.append("g")
      .call(d3.axisLeft(y).ticks(5));

    // axis labels
    g.append("text")
      .attr("x", w/2).attr("y", h + 24)
      .attr("text-anchor", "middle")
      .style("font-size", ".8rem")
      .text("PC 1 (norm.)");
    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -h/2).attr("y", -28)
      .attr("text-anchor", "middle")
      .style("font-size", ".8rem")
      .text("PC 2 (norm.)");

    // ──────────────────────────────────────────────────────────
    // 7) plot the filtered points
    // ──────────────────────────────────────────────────────────
    g.append("g").selectAll("circle")
      .data(points)
      .join("circle")
        .attr("cx", d => x(d.pc1))
        .attr("cy", d => y(d.pc2))
        .attr("r", 4)
        .attr("fill", d => clusterColour(d.cluster))
        .attr("fill-opacity", 0.8);

    // ──────────────────────────────────────────────────────────
    // 8) HTML legend + cluster‐filtering
    // ──────────────────────────────────────────────────────────
    selectedClusters = new Set(d3.range(k));
    function updateClusterSelection() {
      selectedClusters.clear();
      d3.range(k).forEach(i => {
        if (d3.select(`#cluster-checkbox-${i}`).property("checked")) {
          selectedClusters.add(i);
        }
      });
      g.selectAll("circle")
        .attr("fill-opacity", d =>
          selectedClusters.has(d.cluster) ? 0.8 : 0.1
        );
      updateMapVisibility();
      updatePCPVisibility();
      drawDonut();
      drawScatter();
    }
    d3.select("#pca-container").selectAll(".pca-legend").remove();
    const htmlLegend = d3.select("#pca-container")
      .append("div").attr("class","pca-legend");
    d3.range(k).forEach(i => {
      const row = htmlLegend.append("label")
        .style("display","flex")
        .style("align-items","center")
        .style("margin-bottom","6px");
      row.append("input")
        .attr("type","checkbox")
        .property("checked", true)
        .attr("id", `cluster-checkbox-${i}`)
        .on("change", updateClusterSelection);
      row.append("span")
        .text(` Cluster ${i+1}`)
        .style("margin-left","6px")
        .style("color", clusterColour(i))
        .style("font-weight","600");
    });
    updateClusterSelection();

    // ──────────────────────────────────────────────────────────
    // 9) loadings & AvgScore arrow (unchanged)
    // ──────────────────────────────────────────────────────────
    // filter‐out unwanted vectors by their short name:
    const exclude = ['Births','Deaths','DomMig','GrpQtrs','IntMig'];
    const filteredLoadings = loadings.filter(l => !exclude.includes(l.name));
    const maxLen = d3.max(loadings, d => Math.hypot(d.x, d.y)),
          sf     = 0.5 / maxLen;
    const vecG = g.append("g")
                 .attr("stroke","#333")
                 .attr("stroke-width",1.1);
    vecG.selectAll("line")
    .data(filteredLoadings).join("line")
        .attr("x1", x(0)).attr("y1", y(0))
        .attr("x2", d => x(d.x*sf)).attr("y2", d => y(d.y*sf))
        .attr("marker-end","url(#arr-black)")
        .append("title")
          .text(d => `${d.name}\nEigenvalue: ${d.eigenvalue}`);
    vecG.selectAll("text")
    .data(filteredLoadings).join("text")
        .attr("class","loading-label")
        .attr("x", d => x(d.x*sf*1.05))
        .attr("y", d => y(d.y*sf*1.05))
        .text(d => d.name);
    g.append("line")
      .attr("x1", x(0)).attr("y1", y(0))
      .attr("x2", x(avg_loading.x*sf)).attr("y2", y(avg_loading.y*sf))
      .attr("stroke","red").attr("stroke-width",2)
      .attr("marker-end","url(#arr-red)");
    g.append("text")
      .attr("x", x(avg_loading.x*sf*1.05))
      .attr("y", y(avg_loading.y*sf*1.05))
      .attr("fill","red")
      .style("font-size",".75rem")
      .text("AvgScore");
    const defs = svg.append("defs");
    defs.append("marker")
        .attr("id","arr-black")
        .attr("viewBox","0 -4 8 8")
        .attr("markerWidth",6)
        .attr("markerHeight",6)
        .attr("refX",8)
        .attr("orient","auto")
      .append("path")
        .attr("d","M0,-4L8,0L0,4")
        .attr("fill","#333");
    defs.append("marker")
        .attr("id","arr-red")
        .attr("viewBox","0 -4 8 8")
        .attr("markerWidth",6)
        .attr("markerHeight",6)
        .attr("refX",8)
        .attr("orient","auto")
      .append("path")
        .attr("d","M0,-4L8,0L0,4")
        .attr("fill","red");

    // ──────────────────────────────────────────────────────────
    // 10) re-draw linked panels
    // ──────────────────────────────────────────────────────────
    drawDonut();
    drawScatter();
  });
}

/* ────────────────────────────────────────────────────────── */
/*  DRAW Scatterplot with 2D-brush                          */
/* ────────────────────────────────────────────────────────── */
function drawScatter() {
  const variable = scatterSelect.property("value");
  // clear old
  scatterHolder.selectAll("*").remove();

  // apply same filters as PCP & donut
  const pts = rows.filter(r => {
    const cl = clusterOfFips.get(r.FIPS_Code);
    if (!selectedClusters.has(cl)) return false;
    if (activeState   && r.State_Name                  !== activeState)  return false;
    if (activeRegion  && stateRegion.get(r.State_Name) !== activeRegion) return false;
    for (const [col,[mn,mx]] of activePCPBrushes) {
      if (r[col] < mn || r[col] > mx) return false;
    }
    if (activeDonut) {
      const thresh = donutMeans.get(activeDonut),
            col    = eduCols[activeDonut];
      if (r[col] < thresh) return false;
    }
    return true;
  });

  // build (x,y) = (AvgScore, chosen variable)
  const data = pts.map(r => ({
    x: +r.AvgScore,
    y: +r[variable],
    fips: r.FIPS_Code
  }));

  // sizing
  const fullW = scatterHolder.node().clientWidth,
        fullH = scatterHolder.node().clientHeight,
        m     = { top:12, right:12, bottom:36, left:42 },
        W     = fullW - m.left - m.right,
        H     = fullH - m.top  - m.bottom;

  // scales
  const x = d3.scaleLinear()
             .domain(d3.extent(data, d=>d.x))
             .range([0,W]),
       y = d3.scaleLinear()
             .domain(d3.extent(data, d=>d.y))
             .range([H,0]);

  // SVG + axes
  const svg = scatterHolder.append("svg")
                .attr("viewBox", `0 0 ${fullW} ${fullH}`);
  const g = svg.append("g")
               .attr("transform", `translate(${m.left},${m.top})`);

  g.append("g")
    .attr("transform", `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(6));

  g.append("g")
    .call(d3.axisLeft(y).ticks(6));

  // axis labels
  g.append("text")
    .attr("x", W/2).attr("y", H + 30)
    .attr("text-anchor", "middle")
    .text("Avg(Anxiety,Depression)");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -H/2).attr("y", -34)
    .attr("text-anchor", "middle")
    .text(variable);

  // draw points
  const dots = g.selectAll("circle")
    .data(data).join("circle")
      .attr("cx", d=>x(d.x))
      .attr("cy", d=>y(d.y))
      .attr("r", 3)
      .attr("fill-opacity", 0.8)
      .attr("fill", d =>
        clusterColour( clusterOfFips.get(d.fips) )
      );

  // 2D brush
  const brush2d = d3.brush()
  .extent([[0,0],[W,H]])
  .on("brush end", ({selection}) => {
    // reset our FIPS‐set
    activeScatterFips.clear();
    if (selection) {
      const [[x0,y0],[x1,y1]] = selection;
      data.forEach(d => {
        if (
          d.x >= x.invert(x0) && d.x <= x.invert(x1) &&
          d.y >= y.invert(y1) && d.y <= y.invert(y0)
        ) activeScatterFips.add(d.fips);
      });
      // dim points outside the brush
      dots.classed("dim", d => !activeScatterFips.has(d.fips));
    } else {
      // no brush → undim all
      dots.classed("dim", false);
    }
    // propagate to map, PCP & donut:
    updateMapVisibility();
    updatePCPVisibility();
    drawDonut();
    });

  // keep a handle to the brush so reset can clear it
  scatterBrush = brush2d;

  g.append("g")
    .attr("class","brush scatter-brush")
    .call(brush2d);
}


/* ────────────────────────────────────────────────────────── */
/*  DRAW PCP w/ brushing & map linking                      */
/* ────────────────────────────────────────────────────────── */
function drawPCP(){
  // clear out old plot and brushes
  pcpHolder.selectAll("*").remove();
  globalBrushes = [];

  // reset the global brush‐ranges
  activePCPBrushes.clear();

  const W = pcpHolder.node().clientWidth,
        H = pcpHolder.node().clientHeight,
        m = { top:20, right:8, bottom:32, left:8 },
        width  = W - m.left - m.right,
        height = H - m.top  - m.bottom;

  const svg = pcpHolder.append("svg")
               .attr("viewBox", `0 0 ${W} ${H}`)
             .append("g").attr("transform", `translate(${m.left},${m.top})`);

  // scales
  const x = d3.scalePoint()
    .domain(topAxes.map(a=>a.col))
    .range([0,width])
    .padding(0.3);

  const y = {};
  topAxes.forEach(ax=>{
    y[ax.col] = d3.scaleLinear()
      .domain(d3.extent(rows, r=>+r[ax.col])).nice()
      .range([height,0]);
  });

  const line = d3.line()
    .defined(pt=>!isNaN(pt[0]) && !isNaN(pt[1]));

  // only fully-defined rows
  const validRows = rows.filter(r=>
    topAxes.every(ax=> r[ax.col] != null)
  );

  // container for our lines
  const pathsG = svg.append("g").attr("class","pcp-paths");

  // ──────────────────────────────────────────────────────────
  //  DRAW PCP axes + brushing + drag-to-reorder
  // ──────────────────────────────────────────────────────────
  // we’ll keep a handle to the axis <g> selection so we can reorder it
  const axes = svg.append("g")
    .selectAll("g")
    .data(topAxes, d => d.col)
    .join("g")
      .attr("class", "axis")
      .attr("transform", d => `translate(${x(d.col)},0)`)
      // .call(d3.drag()
      // // only start dragging if the event target isn't inside our brush <g>
      // .filter(event => !event.sourceEvent.target.closest('.axis-brush'))
      //   // start with the axis’s current x-pos
      //   .subject((event,d) => ({ x: x(d.col) }))
      //   .on("start", function(event,d){
      //     d3.select(this).raise().classed("dragging", true);
      //   })
      //   .on("drag", function(event,d){
      //     // clamp to [0,width]
      //     const xPos = Math.max(0, Math.min(width, event.x));
      //     d3.select(this).attr("transform", `translate(${xPos},0)`);

      //     // build new order by reading each axis’s current x
      //     const order = axes.nodes()
      //       .map(node => {
      //         const dd = d3.select(node).datum();
      //         const tx = +d3.select(node)
      //                        .attr("transform")
      //                        .match(/translate\(([^,]+)/)[1];
      //         return { dd, tx };
      //       })
      //       .sort((a,b) => a.tx - b.tx)
      //       .map(o => o.dd);

      //     // update the shared topAxes & x-scale domain
      //     topAxes = order;
      //     x.domain(topAxes.map(d => d.col));

      //     // immediately redraw the lines
      //     updateVisibility();
      //   })
      //   .on("end", function(event,d){
      //     d3.select(this).classed("dragging", false);
      //     // snap all axes back to their new “official” x-positions
      //     axes.transition()
      //         .attr("transform", a => `translate(${x(a.col)},0)`);
      //   })
      // );

  // now for each axis, re-attach your axis, label, and brush
  axes.each(function(dim){
    const g = d3.select(this);

    // the vertical axis line
    g.call(d3.axisLeft(y[dim.col]).ticks(3))
      .selectAll("text").style("font-size",".7rem");

    // the axis label above it
    g.append("text")
      .attr("class","axis-label")
      .attr("x",0).attr("y",-8)
      .attr("text-anchor","middle")
      .style("pointer-events","none")
      .style("font-size",".8rem")
      .style("font-weight","600")
      .text(dim.short);


      // brush
      const brush = d3.brushY()
        .extent([[-8,0],[8,height]])
        .on("brush end", ev=>{
          if(ev.selection){
            const [y0,y1] = ev.selection.map(y[dim.col].invert);
            activePCPBrushes.set(
              dim.col,
              [Math.min(y0,y1), Math.max(y0,y1)]
            );
          } else {
            activePCPBrushes.delete(dim.col);
          }
          // re-filter both PCP and map
          // updatePCPVisibility();
          updateMapVisibility();
          drawDonut();
          updatePCPVisibility();
          drawScatter();
        });

      const bg = g.append("g").attr("class","axis-brush").call(brush);
      globalBrushes.push({g:bg, brush});
    });

  // filter + enter/exit
  function updateVisibility(){
    const filtered = validRows.filter(d=>{
      if (activeScatterFips.size && !activeScatterFips.has(d.FIPS_Code)) {
        return false; // drop lines whose FIPS isn’t in the scatter selection
      }
      const cl = clusterOfFips.get(d.FIPS_Code);
      // 1) cluster filter
      if (!selectedClusters.has(cl)) return false;
      // 2) state‐click filter
      if (activeState && d.State_Name !== activeState) return false;
      // 2a) region‐click filter
      if (activeRegion && stateRegion.get(d.State_Name) !== activeRegion) return false;
      // 3) PCP brushing filter
      for (const [col,[mn,mx]] of activePCPBrushes) {
        if (+d[col] < mn || +d[col] > mx) return false;
      }
      // 4) donut‐slice filter
      if (activeDonut) {
        const thresh = donutMeans.get(activeDonut);
        const col    = eduCols[activeDonut];
        if (+d[col] < thresh) return false;
      }
      return true;
    });

    const sel = pathsG.selectAll("path").data(filtered, d=>d.FIPS_Code);

    sel.exit().remove();

    sel.enter()
      .append("path")
        .attr("class","pcp-line")
        .attr("fill","none")
        .attr("stroke-width",1)
        .attr("stroke",d=>clusterColour(clusterOfFips.get(d.FIPS_Code)))
        .attr("stroke-opacity",.6)
      .merge(sel)
        .attr("d", d=> line(
          topAxes.map(ax=>[ x(ax.col), y[ax.col](+d[ax.col]) ])
        ));
  }

  // hook into our global updater
  updatePCPVisibility = updateVisibility;
  updateVisibility();
}

/* ────────────────────────────────────────────────────────── */
/*  DRAW DONUT                                              */
/* ────────────────────────────────────────────────────────── */
function drawDonut(){
  donutHolder.selectAll("*").remove();

    // ──────────────────────────────────────────────────────────
  // filter by: clusters, state‐click, PCP brushes & histogram brush
  // ──────────────────────────────────────────────────────────
  const dataRows = rows.filter(r => {
    if (activeScatterFips.size && !activeScatterFips.has(r.FIPS_Code)) {
      return false; // omit any county not selected in scatter
    }
    const cl = clusterOfFips.get(r.FIPS_Code);
    // 1) cluster must be selected
    if (!selectedClusters.has(cl)) return false;
    // 2) state‐click filter
    if (activeState && r.State_Name !== activeState) return false;
    // 2a) region‐click filter
    if (activeRegion && stateRegion.get(r.State_Name) !== activeRegion) return false;
    // 3) PCP brushing filter
    for (const [col, [mn, mx]] of activePCPBrushes) {
      if (r[col] < mn || r[col] > mx) return false;
    }
    return true;
  });


  const edu = [
    {key:"SomeCollege", col:eduCols.SomeCollege},
    {key:"HSGrad",      col:eduCols.HSGrad},
    {key:"NoHSGrad",    col:eduCols.NoHSGrad},
    {key:"Bachelors+",  col:eduCols["Bachelors+"]}
  ];

  const means = edu.map(e=>({
    label:e.key,
    value:d3.mean(dataRows, d=>+d[e.col])
  }));
  donutMeans = new Map(means.map(m=>[m.label, m.value]));
  const total = d3.sum(means, d=>d.value);
  const pieData = means.map(d=>({label:d.label, value:d.value/total}));

  const {width:W, height:H} = donutHolder.node().getBoundingClientRect();
  const R = Math.min(W,H)*0.4, r0 = R*0.4;

  const svg = donutHolder.append("svg")
               .attr("viewBox",`0 0 ${W} ${H}`)
             .append("g")
               .attr("transform",`translate(${W/2},${H/2})`);

  const donutPalette = [
    "#ff7f0e",  // orange
    "#8c564b",  // brown
    "#7f7f7f",  // gray
    "#00ffff"   // cyan
    ];
  const color = d3.scaleOrdinal()
    .domain(pieData.map(d=>d.label))
    .range(donutPalette);

  const pie = d3.pie().value(d=>d.value).sort(null);
  const arc = d3.arc().innerRadius(r0).outerRadius(R);
  const labArc = d3.arc().innerRadius(R+10).outerRadius(R+10);

  svg.selectAll("path").data(pie(pieData)).join("path")
    .attr("d", arc)
    .attr("fill", d=>color(d.data.label))
    .attr("stroke","#fff")
    .attr("stroke-width",1)
    .on("click", function(event, d) {
      const clicked = d3.select(this);
      const already = clicked.classed("active-slice");

      // reset all slices
      svg.selectAll("path")
        .classed("active-slice", false)
        .classed("dim", false)
        .transition().attr("transform", "translate(0,0)");

      if (!already) {
        activeDonut = d.data.label;

        // pop‐out
        clicked.classed("active-slice", true);
        const [cx, cy] = arc.centroid(d);
        const angle = Math.atan2(cy, cx);
        const offset = 10;
        clicked.transition()
          .attr("transform",
            `translate(${Math.cos(angle)*offset}, ${Math.sin(angle)*offset})`
          );

        // dim the rest
        svg.selectAll("path")
          .filter(p=>p.index!==d.index)
          .classed("dim", true);
      } else {
        activeDonut = null;
      }

      // re-filter map
      updateMapVisibility();
      updatePCPVisibility();
      drawScatter();
    });

  // labels & leader lines omitted for brevity…
  svg.selectAll("polyline").data(pie(pieData)).join("polyline")
    .attr("points", d=>{
      const [x0,y0] = arc.centroid(d),
            [x1,y1] = labArc.centroid(d),
            [x2,y2] = [ x1 + (x1<0? -20:20), y1 ];
      return [[x0,y0],[x1,y1],[x2,y2]];
    })
    .attr("fill","none")
    .attr("stroke","#333")
    .attr("stroke-width",1);

  svg.selectAll("text").data(pie(pieData)).join("text")
    .attr("transform", d=>{
      const [x1,y1] = labArc.centroid(d),
            [x2,y2] = [ x1 + (x1<0? -25:25), y1 ];
      return `translate(${x2},${y2})`;
    })
    .attr("text-anchor", d=> d.startAngle < Math.PI ? "start":"end")
    .style("font-size",".75rem")
    .each(function(d) {
      const pct = (d.data.value*100).toFixed(1) + "%";
      d3.select(this)
        .append("tspan").attr("x",0).attr("dy","0em").text(d.data.label)
        .append("tspan").attr("x",0).attr("dy","1.2em").text(pct);
    });
}

/* ────────────────────────────────────────────────────────── */
/*  COLORBAR HELPER                                         */
/* ────────────────────────────────────────────────────────── */
function makeMetricLegend(svg,W,H){
  const width=160,height=8;
  const x = d3.scaleLinear(choroplethCol.domain(), [0,width]);

  const lg = svg.append("defs")
                .append("linearGradient").attr("id","lg");
  lg.selectAll("stop").data(d3.ticks(0,1,10)).join("stop")
    .attr("offset",d=>d)
    .attr("stop-color",d=>choroplethCol(x.invert(d*width)));

  const g = svg.append("g")
               .attr("id","metric-legend")
               .attr("transform",`translate(8,${H-32})`);
  g.append("rect").attr("width",width).attr("height",height)
   .attr("fill","url(#lg)");
  g.append("g").attr("transform",`translate(0,${height})`)
   .call(d3.axisBottom(x).ticks(5).tickSize(4))
   .select(".domain").remove();
}