from flask import Flask, jsonify, send_from_directory
import pathlib
import numpy as np
import pandas as pd
from scipy.stats import pearsonr
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans
from kneed import KneeLocator

# ─── Paths & mappings ───────────────────────────────────────────
DATA_PATH = pathlib.Path("data.csv")

SHORT_COL = {
    'Employed_2020': 'Employed',
    'Median_Household_Income_2020': 'Income',
    'Unemployment_rate_2020': 'Unemp',
    'Percent of adults completing some college or associate degree, 2019-23': 'SomeCollege',
    'Percent of adults who are high school graduates (or equivalent), 2019-23': 'HSGrad',
    'Percent of adults who are not high school graduates, 2019-23': 'NoHSGrad',
    'Percent of adults with a bachelor\'s degree or higher, 2019-23': 'Bachelors+',
    'BIRTHS_2020': 'Births',
    'DEATHS_2020': 'Deaths',
    'DOMESTIC_MIG_2020': 'DomMig',
    'GQ_ESTIMATES_BASE_2020': 'GrpQtrs',
    'INTERNATIONAL_MIG_2020': 'IntMig',
    'NATURAL_CHG_2020': 'NatChg',
    'NET_MIG_2020': 'NetMig',
    'Anxiety_Score_2020': 'Anxiety',
    'Depression_Score_2020': 'Depression'
}

# ─── Read data & select numeric columns ──────────────────────────
df = pd.read_csv(DATA_PATH)
num_cols = df.select_dtypes(include="number").columns.tolist()
for c in ["FIPS_Code", "avgScore", "Wellbeing_Score_Raw", "Wellbeing_Score"]:
    if c in num_cols:
        num_cols.remove(c)
X_df = df[num_cols].dropna()
sel_index = X_df.index
X = X_df.to_numpy()

# compute the new AvgScore column
df["AvgScore"] = (df["Anxiety_Score_2020"] + df["Depression_Score_2020"]) / 2

# ─── 2-D PCA (axes scaled to ±1) ────────────────────────────────
X_scaled = StandardScaler().fit_transform(X)
pca      = PCA(n_components=2, random_state=42)
coords   = pca.fit_transform(X_scaled)
loadings = pca.components_.T * np.sqrt(pca.explained_variance_)
max_abs  = np.abs(coords).max(axis=0)
coords_n = coords / max_abs
loads_n  = loadings / max_abs

# ─── k-needle → optimal k → k-means clustering ─────────────────
sse    = []
for k in range(1, 11):
    model = KMeans(n_clusters=k, random_state=0, n_init=10)
    model.fit(coords_n)
    sse.append(model.inertia_)

kneedle = KneeLocator(list(range(1,11)), sse, curve="convex", direction="decreasing")
# OPT_K   = int(kneedle.elbow or 4)
OPT_K = 3
clusters = KMeans(n_clusters=OPT_K, random_state=0, n_init=10).fit_predict(coords_n)

# ─── Correlations with AvgScore → pick top-5 ───────────────────
Y = df.loc[sel_index, "AvgScore"]
corr_scores = {}
for col in num_cols:
    if col in ("Anxiety_Score_2020", "Depression_Score_2020"):
        continue
    corr_scores[col] = abs(pearsonr(X_df[col], Y)[0])

top5 = sorted(corr_scores.items(), key=lambda kv: kv[1], reverse=True)[:5]
top_vars_json = [
    {"full": col, "short": SHORT_COL.get(col, col), "corr": round(score,4)}
    for col, score in top5
]

# ─── Build JSON payload ────────────────────────────────────────
points_json = []
for idx, (pt, cl) in enumerate(zip(coords_n, clusters)):
    r = df.loc[sel_index[idx]]
    points_json.append({
        "pc1":     round(float(pt[0]),6),
        "pc2":     round(float(pt[1]),6),
        "cluster": int(cl),
        "fips":    int(r.FIPS_Code),
        "region":  r.Region,
        "state":   r.State_Name
    })

loadings_json = []
for i, col in enumerate(num_cols):
    loadings_json.append({
        "name": SHORT_COL.get(col, col),
        "x":    round(float(loads_n[i,0]),6),
        "y":    round(float(loads_n[i,1]),6),
        "eig":  round(float(np.linalg.norm(loads_n[i])),6)
    })

# compute AvgScore loading vector
from scipy.stats import pearsonr as _pr
c1 = _pr(Y, coords[:,0])[0]/max_abs[0]
c2 = _pr(Y, coords[:,1])[0]/max_abs[1]
avg_loading = {"name":"AvgScore","x":round(c1,6),"y":round(c2,6),"eig":round(np.hypot(c1,c2),6)}

# histogram vars for dropdown
hist_vars = [
    {"full":"Employed_2020","short":SHORT_COL["Employed_2020"]},
    {"full":"Median_Household_Income_2020","short":SHORT_COL["Median_Household_Income_2020"]},
    {"full":"Unemployment_rate_2020","short":SHORT_COL["Unemployment_rate_2020"]},
    {"full":"NATURAL_CHG_2020","short":SHORT_COL["NATURAL_CHG_2020"]},
    {"full":"NET_MIG_2020","short":SHORT_COL["NET_MIG_2020"]},
    {"full":"GQ_ESTIMATES_BASE_2020","short":SHORT_COL["GQ_ESTIMATES_BASE_2020"]}
]

PCA_RESULTS = {
    "k":           OPT_K,
    "points":      points_json,
    "loadings":    loadings_json,
    "top_vars":    top_vars_json,
    "avg_loading": avg_loading,
    "hist_vars":   hist_vars
}

# ─── Flask app ────────────────────────────────────────────────
app = Flask(__name__, static_folder=".", static_url_path="")

@app.route("/")
def root():
    return send_from_directory(".", "index.html")

@app.route("/<path:fname>")
def static_files(fname):
    return send_from_directory(".", fname)

@app.route("/pca")
def pca_api():
    return jsonify(PCA_RESULTS)

if __name__ == "__main__":
    app.run(debug=True)
