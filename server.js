const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

const DATA_FILE = path.join(__dirname, "bierometer-data.json");

const FASSGROESSEN = [30, 50];

const LITER_PRO_PERSON_PRO_STUNDE = 0.5;
const MAX_LITER_PRO_STUNDE = 350;
const TURBO_LITER_PRO_STUNDE = 500;

/*
  Schützenfest-Plan
  tag: 6 = Samstag, 0 = Sonntag, 1 = Montag
*/
const SCHUETZENFEST_PLAN = [
  { tag: 6, tagName: "Samstag", von: "14:00", bis: "18:00", personen: 100 },
  { tag: 6, tagName: "Samstag", von: "18:00", bis: "22:00", personen: 350 },
  { tag: 6, tagName: "Samstag", von: "22:00", bis: "24:00", personen: 180 },

  { tag: 0, tagName: "Sonntag", von: "13:00", bis: "17:00", personen: 450 },
  { tag: 0, tagName: "Sonntag", von: "17:00", bis: "20:00", personen: 350 },
  { tag: 0, tagName: "Sonntag", von: "20:00", bis: "24:00", personen: 250 },

  { tag: 1, tagName: "Montag", von: "11:00", bis: "14:00", personen: 650 },
  { tag: 1, tagName: "Montag", von: "14:00", bis: "17:00", personen: 350 },
  { tag: 1, tagName: "Montag", von: "17:00", bis: "20:00", personen: 300 },
  { tag: 1, tagName: "Montag", von: "20:00", bis: "24:00", personen: 280 }
];

const TEST_LITER_PRO_STUNDE_AUSSERHALB_PLAN = 150;

/*
  Diese Werte werden später über die Admin-Ersteinrichtung gesetzt.
*/
let setupAbgeschlossen = false;
let zapfstellenKonfig = [];

let plan = 0;
let ist = 0;
let anzeigeIst = 0;
let anzeigeLaeuft = false;
let turboBis = 0;
let autoAufholLiter = 0;
let startTime = Date.now();

let zapfstellen = {};
let buchungen = [];

function getZapfstelleConfig(id) {
  return zapfstellenKonfig.find(z => z.id === Number(id));
}

function istGueltigeZapfstelle(stelle) {
  return Boolean(getZapfstelleConfig(stelle));
}

function erstelleLeereZapfstelle() {
  return {
    liter: 0,
    faesser30: 0,
    faesser50: 0,
    freieEingaben: 0,
    anzeigeLiter: 0
  };
}

function initialisiereZapfstellen() {
  zapfstellen = {};

  for (const config of zapfstellenKonfig) {
    zapfstellen[config.id] = erstelleLeereZapfstelle();
  }
}

function sichereZapfstellenStruktur() {
  for (const config of zapfstellenKonfig) {
    const id = config.id;

    if (!zapfstellen[id]) {
      zapfstellen[id] = erstelleLeereZapfstelle();
    }

    if (typeof zapfstellen[id].liter !== "number") {
      zapfstellen[id].liter = 0;
    }

    if (typeof zapfstellen[id].faesser30 !== "number") {
      zapfstellen[id].faesser30 = 0;
    }

    if (typeof zapfstellen[id].faesser50 !== "number") {
      zapfstellen[id].faesser50 = 0;
    }

    if (typeof zapfstellen[id].freieEingaben !== "number") {
      zapfstellen[id].freieEingaben = 0;
    }

    if (typeof zapfstellen[id].anzeigeLiter !== "number") {
      zapfstellen[id].anzeigeLiter = 0;
    }

    if (zapfstellen[id].anzeigeLiter > zapfstellen[id].liter) {
      zapfstellen[id].anzeigeLiter = zapfstellen[id].liter;
    }
  }
}

function normalisiereZapfstellenKonfig(liste) {
  if (!Array.isArray(liste)) {
    return [];
  }

  return liste.map((eintrag, index) => {
    const id = index + 1;

    const nameRaw = String(eintrag.name || `Zapfstelle ${id}`).trim();
    const name = nameRaw || `Zapfstelle ${id}`;

    let gewicht = Number(eintrag.gewicht);

    if (!Number.isFinite(gewicht) || gewicht <= 0) {
      gewicht = 1;
    }

    if (gewicht > 5) {
      gewicht = 5;
    }

    return {
      id,
      name,
      gewicht
    };
  });
}

function ladeDaten() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const daten = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    setupAbgeschlossen = Boolean(daten.setupAbgeschlossen);

    if (Array.isArray(daten.zapfstellenKonfig)) {
      zapfstellenKonfig = normalisiereZapfstellenKonfig(daten.zapfstellenKonfig);
    }

    plan = Number(daten.plan) || 0;
    ist = Number(daten.ist) || 0;
    anzeigeIst = Number(daten.anzeigeIst) || 0;
    anzeigeLaeuft = Boolean(daten.anzeigeLaeuft);
    turboBis = Number(daten.turboBis) || 0;
    autoAufholLiter = Number(daten.autoAufholLiter) || 0;
    startTime = Number(daten.startTime) || Date.now();

    if (anzeigeIst > ist) {
      anzeigeIst = ist;
    }

    if (daten.zapfstellen && typeof daten.zapfstellen === "object") {
      zapfstellen = daten.zapfstellen;
    }

    if (Array.isArray(daten.buchungen)) {
      buchungen = daten.buchungen.slice(-100);
    }

    sichereZapfstellenStruktur();
  } catch (err) {
    console.error("Daten konnten nicht geladen werden:", err.message);
  }
}

function speichereDaten() {
  try {
    const daten = {
      setupAbgeschlossen,
      zapfstellenKonfig,

      plan,
      ist,
      anzeigeIst,
      anzeigeLaeuft,
      turboBis,
      autoAufholLiter,
      startTime,

      zapfstellen,
      buchungen
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(daten, null, 2));
  } catch (err) {
    console.error("Daten konnten nicht gespeichert werden:", err.message);
  }
}

ladeDaten();

function zeitZuMinuten(zeit) {
  const [stunden, minuten] = zeit.split(":").map(Number);
  return stunden * 60 + minuten;
}

function getBerlinZeit() {
  const now = new Date();

  const teile = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const weekdayName = teile.find(t => t.type === "weekday")?.value || "";
  const hour = Number(teile.find(t => t.type === "hour")?.value || 0);
  const minute = Number(teile.find(t => t.type === "minute")?.value || 0);

  const tagMap = {
    Sonntag: 0,
    Montag: 1,
    Dienstag: 2,
    Mittwoch: 3,
    Donnerstag: 4,
    Freitag: 5,
    Samstag: 6
  };

  return {
    tag: tagMap[weekdayName],
    tagName: weekdayName,
    minuten: hour * 60 + minute,
    uhrzeit: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function getAktuellerPlanEintrag() {
  const jetzt = getBerlinZeit();

  return SCHUETZENFEST_PLAN.find(eintrag => {
    const von = zeitZuMinuten(eintrag.von);
    const bis = zeitZuMinuten(eintrag.bis);

    return eintrag.tag === jetzt.tag &&
      jetzt.minuten >= von &&
      jetzt.minuten < bis;
  });
}

function getLiveParameter() {
  const jetzt = getBerlinZeit();
  const eintrag = getAktuellerPlanEintrag();

  if (!eintrag) {
    return {
      modus: "test",
      text: "Außerhalb Festplan / Testbetrieb",
      tagName: jetzt.tagName,
      uhrzeit: jetzt.uhrzeit,
      zeitraum: "-",
      personen: 0,
      literProPersonProStunde: LITER_PRO_PERSON_PRO_STUNDE,
      literProStunde: TEST_LITER_PRO_STUNDE_AUSSERHALB_PLAN,
      maxLiterProStunde: MAX_LITER_PRO_STUNDE
    };
  }

  const berechnet = eintrag.personen * LITER_PRO_PERSON_PRO_STUNDE;
  const literProStunde = Math.min(berechnet, MAX_LITER_PRO_STUNDE);

  return {
    modus: "plan",
    text: `${eintrag.tagName} ${eintrag.von}-${eintrag.bis}`,
    tagName: jetzt.tagName,
    uhrzeit: jetzt.uhrzeit,
    zeitraum: `${eintrag.von}-${eintrag.bis}`,
    personen: eintrag.personen,
    literProPersonProStunde: LITER_PRO_PERSON_PRO_STUNDE,
    literProStunde,
    maxLiterProStunde: MAX_LITER_PRO_STUNDE
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

function berechneAnzeigeGeschwindigkeit() {
  const live = getLiveParameter();
  const rueckstand = ist - anzeigeIst;

  let speed = Number(live.literProStunde) || 0;

  if (rueckstand >= 200) {
    speed *= 3;
  } else if (rueckstand >= 100) {
    speed *= 2;
  } else if (rueckstand >= 50) {
    speed *= 1.5;
  }

  if (Date.now() < turboBis) {
    speed = Math.max(speed, TURBO_LITER_PRO_STUNDE);
  }

  if (autoAufholLiter > 0) {
    speed = Math.max(speed, TURBO_LITER_PRO_STUNDE);
  }

  speed = Math.min(speed, TURBO_LITER_PRO_STUNDE);

  return speed;
}

function getAktiveZapfstellenMitRest() {
  const aktive = [];

  for (const config of zapfstellenKonfig) {
    const id = config.id;
    const z = zapfstellen[id];

    if (!z) {
      continue;
    }

    const restLiter = Math.max(0, z.liter - z.anzeigeLiter);

    if (restLiter > 0.1) {
      aktive.push(config);
    }
  }

  return aktive;
}

function berechneSpeedProZapfstelle() {
  const gesamtSpeed = berechneAnzeigeGeschwindigkeit();
  const aktiveZapfstellen = getAktiveZapfstellenMitRest();

  const speedMap = {};

  for (const config of zapfstellenKonfig) {
    speedMap[config.id] = 0;
  }

  const summeGewichte = aktiveZapfstellen.reduce((summe, config) => {
    return summe + Number(config.gewicht || 1);
  }, 0);

  if (gesamtSpeed <= 0 || summeGewichte <= 0) {
    return speedMap;
  }

  for (const config of aktiveZapfstellen) {
    const gewicht = Number(config.gewicht || 1);
    speedMap[config.id] = gesamtSpeed * (gewicht / summeGewichte);
  }

  return speedMap;
}

function getZapfstellenPrognose() {
  const live = getLiveParameter();
  const speedMap = berechneSpeedProZapfstelle();

  const prognose = {};

  for (const config of zapfstellenKonfig) {
    const id = config.id;
    const z = zapfstellen[id] || erstelleLeereZapfstelle();

    const restLiter = Math.max(0, z.liter - z.anzeigeLiter);
    const speedProZapfstelle = Number(speedMap[id] || 0);

    let minutenBisLeer = null;
    let leerUm = null;
    let status = "kein aktives Fass";

    if (restLiter > 0.1 && speedProZapfstelle > 0) {
      minutenBisLeer = Math.ceil((restLiter / speedProZapfstelle) * 60);

      const leerZeit = new Date(Date.now() + minutenBisLeer * 60 * 1000);

      leerUm = new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(leerZeit);

      if (restLiter <= 5) {
        status = "fast leer";
      } else if (restLiter <= 10) {
        status = "bald leer";
      } else {
        status = "läuft";
      }
    } else if (restLiter > 0.1 && speedProZapfstelle <= 0) {
      status = "Rest vorhanden, Anzeige pausiert";
    }

    prognose[id] = {
      stelle: id,
      name: config.name,
      gewicht: Number(config.gewicht || 1),

      restLiter: Number(restLiter.toFixed(1)),
      anzeigeLiter: Number(z.anzeigeLiter.toFixed(1)),
      gebuchtLiter: Number(z.liter.toFixed(1)),

      minutenBisLeer,
      leerUm,
      status,

      faesser30: z.faesser30,
      faesser50: z.faesser50,
      freieEingaben: z.freieEingaben,

      speedProZapfstelle: Number(speedProZapfstelle.toFixed(1)),
      liveModus: live.modus
    };
  }

  return prognose;
}

function getStatus() {
  return {
    setupAbgeschlossen,
    zapfstellenKonfig,

    plan,
    ist,
    anzeigeIst,
    anzeigeLaeuft,
    turboAktiv: Date.now() < turboBis,
    autoAufholLiter,

    serverTime: Date.now(),
    averageLiterPerMs: getAverageLiterPerMs(),

    live: getLiveParameter(),
    aktuelleAnzeigeGeschwindigkeit: berechneAnzeigeGeschwindigkeit(),

    zapfstellen,
    zapfstellenPrognose: getZapfstellenPrognose(),

    letzteBuchungen: buchungen.slice(-10).reverse()
  };
}

function sendeUpdate() {
  io.emit("update", getStatus());
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
  const z = zapfstellen[stelle];

  if (!z) {
    return;
  }

  if (typ === "fass30" || typ === "fass50") {
    const rechnerischerRest = Math.max(0, z.liter - z.anzeigeLiter);

    if (rechnerischerRest > 1) {
      autoAufholLiter += rechnerischerRest;

      buchungen.push({
        zeit: new Date().toISOString(),
        stelle,
        liter: Number(rechnerischerRest.toFixed(1)),
        typ: "autoAufholen"
      });
    }
  }

  ist += liter;

  if (anzeigeIst > ist) {
    anzeigeIst = ist;
  }

  z.liter += liter;

  if (typ === "fass30") {
    z.faesser30 += 1;
  }

  if (typ === "fass50") {
    z.faesser50 += 1;
  }

  if (typ === "frei") {
    z.freieEingaben += 1;
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

  speichereDaten();
  triggerLokaleAnzeige();
  sendeUpdate();
}

let letzterAnzeigeTick = Date.now();

function verteileAnzeigeFortschritt(deltaLiter) {
  let rest = deltaLiter;

  if (rest <= 0) {
    return;
  }

  for (let runde = 0; runde < 10; runde++) {
    if (rest <= 0.0001) {
      break;
    }

    const aktive = getAktiveZapfstellenMitRest();

    if (!aktive.length) {
      break;
    }

    const summeGewichte = aktive.reduce((summe, config) => {
      return summe + Number(config.gewicht || 1);
    }, 0);

    if (summeGewichte <= 0) {
      break;
    }

    let verteilt = 0;

    for (const config of aktive) {
      const z = zapfstellen[config.id];
      const offen = Math.max(0, z.liter - z.anzeigeLiter);
      const gewicht = Number(config.gewicht || 1);

      const anteilSoll = rest * (gewicht / summeGewichte);
      const anteil = Math.min(offen, anteilSoll);

      if (anteil > 0) {
        z.anzeigeLiter += anteil;
        verteilt += anteil;
      }
    }

    rest -= verteilt;

    if (verteilt <= 0.0001) {
      break;
    }
  }
}

function tickAnzeige() {
  const now = Date.now();
  const deltaMs = now - letzterAnzeigeTick;
  letzterAnzeigeTick = now;

  if (!anzeigeLaeuft) {
    return;
  }

  if (anzeigeIst >= ist) {
    anzeigeIst = ist;
    return;
  }

  const vorher = anzeigeIst;

  const literProStunde = berechneAnzeigeGeschwindigkeit();
  const literProMs = literProStunde / 60 / 60 / 1000;

  if (literProMs <= 0) {
    return;
  }

  anzeigeIst += literProMs * deltaMs;

  if (anzeigeIst > ist) {
    anzeigeIst = ist;
  }

  const deltaLiter = Math.max(0, anzeigeIst - vorher);

  if (deltaLiter > 0) {
    verteileAnzeigeFortschritt(deltaLiter);

    if (autoAufholLiter > 0) {
      autoAufholLiter = Math.max(0, autoAufholLiter - deltaLiter);
    }
  }
}

app.get("/api/status", (req, res) => {
  res.json(getStatus());
});

app.post("/api/setup", (req, res) => {
  const anzahl = Number(req.body.anzahl);
  const liste = req.body.zapfstellen;

  if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > 30) {
    return res.status(400).send("Ungültige Anzahl Zapfstellen");
  }

  if (!Array.isArray(liste) || liste.length !== anzahl) {
    return res.status(400).send("Zapfstellen-Liste passt nicht zur Anzahl");
  }

  zapfstellenKonfig = normalisiereZapfstellenKonfig(liste);
  setupAbgeschlossen = true;

  sichereZapfstellenStruktur();

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/reset", (req, res) => {
  plan = 0;
  ist = 0;
  anzeigeIst = 0;
  anzeigeLaeuft = false;
  turboBis = 0;
  autoAufholLiter = 0;
  startTime = Date.now();
  buchungen = [];

  initialisiereZapfstellen();

  speichereDaten();

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

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/start", (req, res) => {
  anzeigeLaeuft = true;

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/pause", (req, res) => {
  anzeigeLaeuft = false;

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/aufholen", (req, res) => {
  turboBis = Date.now() + 5 * 60 * 1000;
  anzeigeLaeuft = true;

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/angleichen", (req, res) => {
  anzeigeIst = ist;

  for (const config of zapfstellenKonfig) {
    const id = config.id;

    if (zapfstellen[id]) {
      zapfstellen[id].anzeigeLiter = zapfstellen[id].liter;
    }
  }

  autoAufholLiter = 0;

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/fass", (req, res) => {
  const stelle = Number(req.body.stelle);
  const liter = Number(req.body.liter);

  if (!setupAbgeschlossen) {
    return res.status(400).send("Setup noch nicht abgeschlossen");
  }

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

  if (!setupAbgeschlossen) {
    return res.status(400).send("Setup noch nicht abgeschlossen");
  }

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

setInterval(() => {
  tickAnzeige();
  sendeUpdate();
}, 1000);

setInterval(() => {
  speichereDaten();
}, 10000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});