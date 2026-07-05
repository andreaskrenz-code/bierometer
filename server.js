const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static("public"));

const ANZAHL_ZAPFSTELLEN = 5;
const FASSGROESSEN = [30, 50];

let plan = 0;
let ist = 0;

let startTime = Date.now();

let zapfstellen = {};
let buchungen = [];

for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
  zapfstellen[i] = {
    liter: 0,
    faesser30: 0,
    faesser50: 0,
    freieEingaben: 0
  };
}

function getAverageLiterPerMs() {
  const now = Date.now();
  const laufzeitMs = Math.max(now - startTime, 1);

  if (ist <= 0) {
    return 0;
  }

  return ist / laufzeitMs;
}

function getStatus() {
  return {
    plan,
    ist,
    serverTime: Date.now(),
    averageLiterPerMs: getAverageLiterPerMs(),
    zapfstellen,
    letzteBuchungen: buchungen.slice(-10).reverse()
  };
}

function sendeUpdate() {
  io.emit("update", getStatus());
}

function istGueltigeZapfstelle(stelle) {
  return Number.isInteger(stelle) &&
    stelle >= 1 &&
    stelle <= ANZAHL_ZAPFSTELLEN;
}

function triggerLokaleAnzeige() {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  try {
    fs.writeFileSync("C:/bierometer/show.txt", "1");
  } catch (err) {
    console.error("show.txt konnte nicht geschrieben werden:", err.message);
  }
}

function bucheLiter({ stelle, liter, typ }) {
  ist += liter;

  zapfstellen[stelle].liter += liter;

  if (typ === "fass30") {
    zapfstellen[stelle].faesser30 += 1;
  }

  if (typ === "fass50") {
    zapfstellen[stelle].faesser50 += 1;
  }

  if (typ === "frei") {
    zapfstellen[stelle].freieEingaben += 1;
  }

  buchungen.push({
    zeit: new Date().toISOString(),
    stelle,
    liter,
    typ
  });

  if (buchungen.length > 100) {
    buchungen = buchungen.slice(-100);
  }

  triggerLokaleAnzeige();
  sendeUpdate();
}

app.post("/api/reset", (req, res) => {
  plan = 0;
  ist = 0;
  startTime = Date.now();
  buchungen = [];

  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    zapfstellen[i] = {
      liter: 0,
      faesser30: 0,
      faesser50: 0,
      freieEingaben: 0
    };
  }

  io.emit("reset");
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/plan", (req, res) => {
  const liter = Number(req.body.liter);

  if (!Number.isFinite(liter) || liter < 0) {
    return res.status(400).send("Ungültiger Zielwert");
  }

  plan = liter;

  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/fass", (req, res) => {
  const stelle = Number(req.body.stelle);
  const liter = Number(req.body.liter);

  if (!istGueltigeZapfstelle(stelle)) {
    return res.status(400).send("Ungültige Zapfstelle");
  }

  if (!FASSGROESSEN.includes(liter)) {
    return res.status(400).send("Ungültige Fassgröße");
  }

  bucheLiter({
    stelle,
    liter,
    typ: liter === 30 ? "fass30" : "fass50"
  });

  res.json({
    ok: true,
    stelle,
    liter,
    ...getStatus()
  });
});

app.post("/api/verkauf", (req, res) => {
  const stelle = Number(req.body.stelle);
  const liter = Number(req.body.liter);

  if (!istGueltigeZapfstelle(stelle)) {
    return res.status(400).send("Ungültige Zapfstelle");
  }

  if (!Number.isFinite(liter) || liter <= 0) {
    return res.status(400).send("Ungültiger Wert");
  }

  bucheLiter({
    stelle,
    liter,
    typ: "frei"
  });

  res.json({
    ok: true,
    stelle,
    liter,
    ...getStatus()
  });
});

io.on("connection", socket => {
  socket.emit("update", getStatus());
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});