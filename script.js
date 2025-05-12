/* ────────────────────────────────────────────────────────── */
/*  GLOBALS & HELPERS                                       */
/* ────────────────────────────────────────────────────────── */
const CSV_URL    = "data.csv",
      GEO_URL    = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

const pcpResetBtn = document.getElementById("reset-pcp"),
      histSelect  = document.getElementById("hist-select");

const mapHolder   = d3.select("#choropleth"),
      pcaHolder   = d3.select("#pca-biplot"),
      pcpHolder   = d3.select("#pcp-plot"),
      histHolder  = d3.select("#histogram"),
      donutHolder = d3.select("#donut-chart");

// shared state
let rows                = [],
    stateOfFips         = new Map(),
    stateRegion         = new Map(),
    activeState         = null,
    clusterOfFips       = new Map(),
    topAxes             = [],      // [{col, short}, ...]
    globalBrushes       = [],      // for PCP reset
    updatePCPVisibility = () => {}; // placeholder

let clusterColour;  // set after PCA

let activeDonut     = null;     // which slice is clicked
let donutMeans      = new Map();
const eduCols = {               // same keys as in drawDonut()
  SomeCollege: "Percent of adults completing some college or associate degree, 2019-23",
  HSGrad:      "Percent of adults who are high school graduates (or equivalent), 2019-23",
  NoHSGrad:    "Percent of adults who are not high school graduates, 2019-23",
  "Bachelors+": "Percent of adults with a bachelor's degree or higher, 2019-23"
};

let activeHistCol   = null;     // which column is brushed
let activeHistRange = null;     // [min, max] in data‐space
let activeHistYRange = null;

// keep track of which clusters are checked in the legend
let selectedClusters = new Set();

// track the latest PCP axis‐brush ranges for the map filter
let activePCPBrushes = new Map();

// color scales
const regionColour  = {
  Northeast:"#E4576E", Midwest:"#4E79A7",
  South:"#76B7B2",     West:"#F28E2C"
};
const choroplethCol = d3.scaleSequential(d3.interpolateBlues);


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
  choroplethCol.domain(d3.extent(rows, d=>d.AvgScore));

  drawMap(topo);
  drawPCA();
});


/* ────────────────────────────────────────────────────────── */
/*  DRAW CHOROPLETH                                         */
/* ────────────────────────────────────────────────────────── */
function drawMap(topo) {
  mapHolder.selectAll("*").remove();
  const W = mapHolder.node().clientWidth,
        H = mapHolder.node().clientHeight;

  const projection = d3.geoAlbersUsa()
        .fitSize([W,H], topojson.feature(topo, topo.objects.counties));
  const path = d3.geoPath(projection);

  const svg = mapHolder.append("svg")
               .attr("viewBox", `0 0 ${W} ${H}`);

  // counties
  svg.append("g").attr("class","counties")
    .selectAll("path").data(topojson.feature(topo, topo.objects.counties).features)
    .join("path")
      .attr("d", path)
      .attr("fill", d=>{
        const r = rows.find(r=>r.FIPS_Code===+d.id);
        if (!r || r.AvgScore == null) return "#ccc";
        return choroplethCol(r.AvgScore);
      })
      .attr("stroke","#fff").attr("stroke-width",.25)
      .attr("cursor","pointer")
      .on("click", (_,d)=>{
        const st = stateOfFips.get(+d.id);
        activeState = (activeState===st ? null : st);
        updateMapVisibility();
        drawHistogram(histSelect.value);
        drawDonut();
        updatePCPVisibility();
      })
      .append("title")
        .text(d=>stateOfFips.get(+d.id));

  // state outlines
  svg.append("g").attr("class","states")
    .selectAll("path").data(topojson.feature(topo, topo.objects.states).features)
    .join("path")
      .attr("d", path)
      .attr("fill","none")
      .attr("stroke", d=>regionColour[stateRegion.get(d.properties.name)]||"#888");

  makeMetricLegend(svg, W, H);

  // expose for all filters
  updateMapVisibility = () => {
    svg.selectAll(".counties path")
      .classed("dim", d => {
        const fips = +d.id;
        const r    = rows.find(r=>r.FIPS_Code===fips);
        const st   = stateOfFips.get(fips);
        const cl   = clusterOfFips.get(fips);

        // 1) PCA cluster filter
        if (!selectedClusters.has(cl)) return true;
        // 2) state-click
        if (activeState && st !== activeState) return true;
        // 3) PCP brushes
        for (const [col,[mn,mx]] of activePCPBrushes) {
          if (r[col] < mn || r[col] > mx) return true;
        }
        // 4) histogram X-range
        if (activeHistRange && activeHistCol) {
          if (r[activeHistCol] < activeHistRange[0]
           || r[activeHistCol] > activeHistRange[1]) 
            return true;
        }
        // 5) donut slice
        if (activeDonut) {
          const thresh = donutMeans.get(activeDonut);
          const col    = eduCols[activeDonut];
          if (r[col] < thresh) return true;
        }
        return false;  // else keep visible
      });

    // dim states only on activeState
    svg.selectAll(".states path")
      .classed("dim", d => activeState && d.properties.name !== activeState);
  };
  updateMapVisibility();
}

function drawPCA() {
  // wipe out any old biplot
  pcaHolder.selectAll("*").remove();

  // fetch new PCA results
  d3.json("/pca").then(({ k, points, loadings, top_vars, avg_loading, hist_vars }) => {
    // ──────────────────────────────────────────────────────────
    // 1) clustering setup
    // ──────────────────────────────────────────────────────────
    clusterOfFips = new Map(points.map(p => [p.fips, p.cluster]));
    clusterColour = d3.scaleOrdinal(d3.schemeCategory10)
                      .domain(d3.range(k));

    // ──────────────────────────────────────────────────────────
    // 2) prepare rows & axes list
    // ──────────────────────────────────────────────────────────
    top_vars.forEach(v => {
      rows.forEach(r => {
        r[v.short] = r[v.full];
      });
    });
    topAxes = [
      { col: "AvgScore", short: "AvgScore" },
      ...top_vars.map(v => ({ col: v.short, short: v.short }))
    ];

    // ──────────────────────────────────────────────────────────
    // 3) histogram dropdown
    // ──────────────────────────────────────────────────────────
    histSelect.innerHTML = "";
    hist_vars.forEach(v => {
      histSelect.add(new Option(v.short, v.full));
    });
    histSelect.onchange = () => drawHistogram(histSelect.value);

    // ──────────────────────────────────────────────────────────
    // 4) draw & wire up PCP first (for cross‐linking)
    // ──────────────────────────────────────────────────────────
    drawPCP();
    pcpResetBtn.addEventListener("click", () => {
      globalBrushes.forEach(({ g, brush }) => g.call(brush.move, null));
      activeState = null;
      updateMapVisibility();
      drawHistogram(histSelect.value);
      drawDonut();
      updatePCPVisibility();
    });

    // ──────────────────────────────────────────────────────────
    // 5) set up SVG & scales for PCA
    // ──────────────────────────────────────────────────────────
    const W = pcaHolder.node().clientWidth,
          H = pcaHolder.node().clientHeight,
          m = { top: 18, right: 12, bottom: 28, left: 34 },
          w = W - m.left - m.right,
          h = H - m.top  - m.bottom;

    const x = d3.scaleLinear([-1.05, 1.05], [0, w]),
          y = d3.scaleLinear([-1.05, 1.05], [h, 0]);

    const svg = pcaHolder.append("svg")
                 .attr("viewBox", `0 0 ${W} ${H}`);
    const g   = svg.append("g")
                 .attr("transform", `translate(${m.left},${m.top})`);

    // grid‐lines
    g.append("g").selectAll("line")
      .data(d3.range(-1, 1.1, 0.5)).join("line")
      .attr("class","grid-line")
      .attr("x1", x(-1.05)).attr("x2", x(1.05))
      .attr("y1", d=>y(d)).attr("y2", d=>y(d));
    g.append("g").selectAll("line")
      .data(d3.range(-1, 1.1, 0.5)).join("line")
      .attr("class","grid-line")
      .attr("y1", y(-1.05)).attr("y2", y(1.05))
      .attr("x1", d=>x(d)).attr("x2", d=>x(d));

    // axes
    g.append("g")
      .attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(5));
    g.append("g")
      .call(d3.axisLeft(y).ticks(5));
    g.append("text")
      .attr("x", w/2).attr("y", h+24)
      .attr("text-anchor","middle")
      .style("font-size",".8rem")
      .text("PC 1 (norm.)");
    g.append("text")
      .attr("transform","rotate(-90)")
      .attr("x", -h/2).attr("y", -28)
      .attr("text-anchor","middle")
      .style("font-size",".8rem")
      .text("PC 2 (norm.)");

    // ──────────────────────────────────────────────────────────
    // 6) draw the points
    // ──────────────────────────────────────────────────────────
    g.append("g").selectAll("circle")
      .data(points)
      .join("circle")
        .attr("cx", d=>x(d.pc1))
        .attr("cy", d=>y(d.pc2))
        .attr("r", 4)
        .attr("fill", d=>clusterColour(d.cluster))
        .attr("fill-opacity", 0.8);

    // ──────────────────────────────────────────────────────────
    // 7) NEW: HTML legend + cross‐chart cluster filtering
    // ──────────────────────────────────────────────────────────
    // initialize
    selectedClusters = new Set(d3.range(k));

    // helper to re‐draw everything
    function updateClusterSelection() {
      selectedClusters.clear();
      d3.range(k).forEach(i => {
        if (d3.select(`#cluster-checkbox-${i}`).property("checked")) {
          selectedClusters.add(i);
        }
      });

      // PCA: dim circles
      g.selectAll("circle")
        .attr("fill-opacity", d =>
          selectedClusters.has(d.cluster) ? 0.8 : 0.1
        );

      // all other panels
      updateMapVisibility();
      updatePCPVisibility();
      drawHistogram(histSelect.value);
      drawDonut();
    }

    // build the legend
    d3.select("#pca-container").selectAll(".pca-legend").remove();
    const htmlLegend = d3.select("#pca-container")
      .append("div")
        .attr("class","pca-legend");

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

    // run once on load
    updateClusterSelection();

    // ──────────────────────────────────────────────────────────
    // 8) draw loadings & AvgScore arrow
    // ──────────────────────────────────────────────────────────
    const maxLen = d3.max(loadings, d=>Math.hypot(d.x,d.y)),
          sf     = 0.9 / maxLen;

    const vecG = g.append("g")
                 .attr("stroke","#333")
                 .attr("stroke-width",1.1);
    vecG.selectAll("line")
      .data(loadings)
      .join("line")
        .attr("x1", x(0)).attr("y1", y(0))
        .attr("x2", d=>x(d.x*sf)).attr("y2", d=>y(d.y*sf))
        .attr("marker-end","url(#arr-black)")
        .append("title")
        .text(d => `${d.name} — eigen: ${d.eigenvalue}`);
    vecG.selectAll("text")
      .data(loadings)
      .join("text")
        .attr("class","loading-label")
        .attr("x", d=>x(d.x*sf*1.05))
        .attr("y", d=>y(d.y*sf*1.05))
        .text(d=>d.name);

    // AvgScore vector
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

    // arrow markers definitions
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
    // 9) finally link other panels
    // ──────────────────────────────────────────────────────────
    drawHistogram(histSelect.value);
    drawDonut();
  });
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
        m = { top:20, right:8, bottom:16, left:8 },
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

  // draw axes + attach Y‐brushes
  svg.append("g")
    .selectAll("g")
    .data(topAxes)
    .join("g")
      .attr("transform", d=>`translate(${x(d.col)},0)`)
    .each(function(dim){
      const g = d3.select(this);

      // axis
      g.call(d3.axisLeft(y[dim.col]).ticks(3))
       .selectAll("text").style("font-size",".7rem");

      // label
      g.append("text")
       .attr("x",0).attr("y",-10)
       .attr("text-anchor","middle")
       .style("font-size",".8rem").style("font-weight","600")
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
          updatePCPVisibility();
          updateMapVisibility();
        });

      const bg = g.append("g").attr("class","axis-brush").call(brush);
      globalBrushes.push({g:bg, brush});
    });

  // filter + enter/exit
  function updateVisibility(){
    const filtered = validRows.filter(d=>{
      const cl = clusterOfFips.get(d.FIPS_Code);
      if (!selectedClusters.has(cl)) return false;

      // PCP brushing
      for(const [col,[mn,mx]] of activePCPBrushes){
        if(+d[col] < mn || +d[col] > mx) return false;
      }
      // state‐click filter
      if(activeState && d.State_Name !== activeState) return false;
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
/*  DRAW HISTOGRAM                                           */
/* ────────────────────────────────────────────────────────── */
function drawHistogram(column) {
  histHolder.selectAll("*").remove();

  // filter by state & cluster selection
  const dataRows = rows.filter(r => {
    const cl = clusterOfFips.get(r.FIPS_Code),
          stateOk = !activeState || r.State_Name === activeState;
    return stateOk && selectedClusters.has(cl);
  });

  // pull out the numeric values
  const data = dataRows.map(r => +r[column]).filter(v => !isNaN(v));

  // sizing
  const fullW = histHolder.node().clientWidth,
        fullH = histHolder.node().clientHeight;
  const m = { top: 12, right: 24, bottom: 35, left: 36 },
        W = fullW - m.left - m.right,
        H = fullH - m.top  - m.bottom;

  // scales + bins
  const x = d3.scaleLinear()
              .domain(d3.extent(data)).nice()
              .range([0, W]);
  const bins = d3.bin()
                 .domain(x.domain())
                 .thresholds(30)(data);
  const y = d3.scaleLinear()
              .domain([0, d3.max(bins, d => d.length)]).nice()
              .range([H, 0]);

  // base SVG + axes
  const svg = histHolder.append("svg")
                .attr("viewBox", `0 0 ${fullW} ${fullH}`);
  const g = svg.append("g")
               .attr("transform", `translate(${m.left},${m.top})`);

  g.append("g")
    .attr("transform", `translate(0,${H})`)
    .call(d3.axisBottom(x).ticks(6));
  g.append("g")
    .call(d3.axisLeft(y).ticks(5));

  // draw bars
  const bars = g.selectAll("rect")
    .data(bins)
    .join("rect")
      .attr("x",      d => x(d.x0) + 0.5)
      .attr("y",      d => y(d.length))
      .attr("width",  d => Math.max(1, x(d.x1) - x(d.x0) - 1))
      .attr("height", d => H - y(d.length))
      .attr("fill",   "#4E79A7");

  // ──────────────────────────────────────────────────────────
  //  BRUSH STATE & UPDATE FUNCTION
  // ──────────────────────────────────────────────────────────
  let activeX = null;
  let activeY = null;

  function updateBars() {
    bars.classed("dim", d => {
      // X‐axis filter
      if (activeHistRange) {
        const [xmin, xmax] = activeHistRange;
        if (d.x0 < xmin || d.x1 > xmax) return true;
      }
      // Y‐axis filter (frequency)
      if (activeHistYRange) {
        const [ymin, ymax] = activeHistYRange;
        if (d.length < ymin || d.length > ymax) return true;
      }
      return false;
    });
  }
  

  // ──────────────────────────────────────────────────────────
//  RECTANGULAR BRUSH (x + y simultaneously)
// ──────────────────────────────────────────────────────────
const brush2d = d3.brush()
.extent([[0, 0], [W, H]])
.on("brush end", ({selection}) => {
  if (selection) {
    // selection = [[x0,y0], [x1,y1]]
    const [[x0, y0], [x1, y1]] = selection;
    activeHistCol    = column;
    activeHistRange  = [ x.invert(x0), x.invert(x1) ].sort((a,b)=>a-b);
    activeHistYRange = [ y.invert(y1), y.invert(y0) ].sort((a,b)=>a-b);
  } else {
    activeHistCol    = null;
    activeHistRange  = null;
    activeHistYRange = null;
  }
  updateBars();
  updateMapVisibility();
});

g.append("g")
.attr("class", "brush hist-brush")
.call(brush2d);

}

/* ────────────────────────────────────────────────────────── */
/*  DRAW DONUT                                              */
/* ────────────────────────────────────────────────────────── */
function drawDonut(){
  donutHolder.selectAll("*").remove();

  const dataRows = rows.filter(r=>{
    const cl = clusterOfFips.get(r.FIPS_Code),
          ok = !activeState || r.State_Name === activeState;
    return ok && selectedClusters.has(cl);
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
  const R = Math.min(W,H)*0.4, r0 = R*0.6;

  const svg = donutHolder.append("svg")
               .attr("viewBox",`0 0 ${W} ${H}`)
             .append("g")
               .attr("transform",`translate(${W/2},${H/2})`);

  const color = d3.scaleOrdinal()
    .domain(pieData.map(d=>d.label))
    .range(d3.schemeTableau10);

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
               .attr("transform",`translate(${W-width-8},${H-32})`);
  g.append("rect").attr("width",width).attr("height",height)
   .attr("fill","url(#lg)");
  g.append("g").attr("transform",`translate(0,${height})`)
   .call(d3.axisBottom(x).ticks(5).tickSize(4))
   .select(".domain").remove();
}