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

const ANZAHL_ZAPFSTELLEN = 5;
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

/*
  Damit du auch außerhalb der Festzeiten testen kannst.
  Während des Festplans wird automatisch nach Personenanzahl gerechnet.
*/
const TEST_LITER_PRO_STUNDE_AUSSERHALB_PLAN = 150;

// Soll-Wert
let plan = 0;

// Echter IST-Wert: Summe aller gebuchten Fässer/Liter
let ist = 0;

// Sichtbarer IST-Wert: Das, was auf dem Display steht
let anzeigeIst = 0;

// Anzeige läuft oder pausiert
let anzeigeLaeuft = false;

// Turbo-Aufholen aktiv bis Zeitpunkt
let turboBis = 0;

/*
  Automatischer Aufhol-Puffer in Litern.
  Wird gefüllt, wenn an einer Zapfstelle ein neues Fass gebucht wird,
  obwohl dort rechnerisch noch Rest im alten Fass vorhanden war.
*/
let autoAufholLiter = 0;

let startTime = Date.now();

let zapfstellen = {};
let buchungen = [];

function initialisiereZapfstellen() {
  zapfstellen = {};

  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    zapfstellen[i] = {
      liter: 0,
      faesser30: 0,
      faesser50: 0,
      freieEingaben: 0,

      /*
        Wie viele Liter dieser Zapfstelle auf der Anzeige rechnerisch
        schon zugeordnet wurden.
      */
      anzeigeLiter: 0
    };
  }
}

initialisiereZapfstellen();

function ladeDaten() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const daten = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

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

    for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
      if (!zapfstellen[i]) {
        zapfstellen[i] = {
          liter: 0,
          faesser30: 0,
          faesser50: 0,
          freieEingaben: 0,
          anzeigeLiter: 0
        };
      }

      if (typeof zapfstellen[i].liter !== "number") {
        zapfstellen[i].liter = 0;
      }

      if (typeof zapfstellen[i].faesser30 !== "number") {
        zapfstellen[i].faesser30 = 0;
      }

      if (typeof zapfstellen[i].faesser50 !== "number") {
        zapfstellen[i].faesser50 = 0;
      }

      if (typeof zapfstellen[i].freieEingaben !== "number") {
        zapfstellen[i].freieEingaben = 0;
      }

      if (typeof zapfstellen[i].anzeigeLiter !== "number") {
        zapfstellen[i].anzeigeLiter = 0;
      }

      if (zapfstellen[i].anzeigeLiter > zapfstellen[i].liter) {
        zapfstellen[i].anzeigeLiter = zapfstellen[i].liter;
      }
    }
  } catch (err) {
    console.error("Daten konnten nicht geladen werden:", err.message);
  }
}

function speichereDaten() {
  try {
    const daten = {
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

  // Automatische Aufholstufen
  if (rueckstand >= 200) {
    speed *= 3;
  } else if (rueckstand >= 100) {
    speed *= 2;
  } else if (rueckstand >= 50) {
    speed *= 1.5;
  }

  // Manueller Turbo
  if (Date.now() < turboBis) {
    speed = Math.max(speed, TURBO_LITER_PRO_STUNDE);
  }

  // Automatisches Aufholen pro Zapfstelle
  if (autoAufholLiter > 0) {
    speed = Math.max(speed, TURBO_LITER_PRO_STUNDE);
  }

  // Absolute Obergrenze
  speed = Math.min(speed, TURBO_LITER_PRO_STUNDE);

  return speed;
}

/*
  Fass-Prognose:
  Berechnet pro Zapfstelle den rechnerischen Rest und eine ungefähre Leerzeit.
  Das ist eine Schätzung, weil die App nicht exakt weiß, an welcher Zapfstelle
  gerade wie viel gezapft wird.
*/
function getZapfstellenPrognose() {
  const live = getLiveParameter();
  const gesamtSpeed = berechneAnzeigeGeschwindigkeit();

  const aktiveZapfstellen = [];

  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    const zapfstelle = zapfstellen[i];
    const restLiter = Math.max(0, zapfstelle.liter - zapfstelle.anzeigeLiter);

    if (restLiter > 0.1) {
      aktiveZapfstellen.push(i);
    }
  }

  const speedProZapfstelle = aktiveZapfstellen.length > 0
    ? gesamtSpeed / aktiveZapfstellen.length
    : 0;

  const prognose = {};

  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    const zapfstelle = zapfstellen[i];
    const restLiter = Math.max(0, zapfstelle.liter - zapfstelle.anzeigeLiter);

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

    prognose[i] = {
      stelle: i,
      restLiter: Number(restLiter.toFixed(1)),
      anzeigeLiter: Number(zapfstelle.anzeigeLiter.toFixed(1)),
      gebuchtLiter: Number(zapfstelle.liter.toFixed(1)),
      minutenBisLeer,
      leerUm,
      status,
      faesser30: zapfstelle.faesser30,
      faesser50: zapfstelle.faesser50,
      freieEingaben: zapfstelle.freieEingaben,
      speedProZapfstelle: Number(speedProZapfstelle.toFixed(1)),
      liveModus: live.modus
    };
  }

  return prognose;
}

function getStatus() {
  return {
    plan,

    // echter gebuchter Wert
    ist,

    // sichtbarer Anzeige-Wert
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
  const zapfstelle = zapfstellen[stelle];

  /*
    Automatisches Angleichen:
    Wenn an dieser Zapfstelle ein neues Fass gebucht wird,
    obwohl dort rechnerisch noch Rest im bisherigen Fass vorhanden war,
    dann muss die Anzeige offenbar hinterherhängen.
  */
  if (typ === "fass30" || typ === "fass50") {
    const rechnerischerRest = Math.max(0, zapfstelle.liter - zapfstelle.anzeigeLiter);

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

  zapfstelle.liter += liter;

  if (typ === "fass30") {
    zapfstelle.faesser30 += 1;
  }

  if (typ === "fass50") {
    zapfstelle.faesser50 += 1;
  }

  if (typ === "frei") {
    zapfstelle.freieEingaben += 1;
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

/*
  Verteilt den sichtbaren Anzeige-Fortschritt rechnerisch auf die Zapfstellen.
  Dadurch weiß die App ungefähr, wie viel Liter pro Zapfstelle schon "verbraucht"
  angezeigt wurden.
*/
function verteileAnzeigeFortschritt(deltaLiter) {
  let rest = deltaLiter;

  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    if (rest <= 0) {
      break;
    }

    const zapfstelle = zapfstellen[i];
    const offen = Math.max(0, zapfstelle.liter - zapfstelle.anzeigeLiter);

    if (offen <= 0) {
      continue;
    }

    const anteil = Math.min(offen, rest);
    zapfstelle.anzeigeLiter += anteil;
    rest -= anteil;
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
  // 5 Minuten Turbo-Aufholen
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
  // Anzeige sofort auf echten IST-Wert setzen
  anzeigeIst = ist;

  // Auch die Zapfstellen rechnerisch angleichen
  for (let i = 1; i <= ANZAHL_ZAPFSTELLEN; i++) {
    zapfstellen[i].anzeigeLiter = zapfstellen[i].liter;
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

/*
  Der Server zählt zentral die Anzeige hoch.
  Dadurch starten neue Display-Fenster nicht mehr bei 0,
  sondern bekommen sofort den aktuellen Anzeige-Wert.
*/
setInterval(() => {
  tickAnzeige();
  sendeUpdate();
}, 1000);

/*
  Regelmäßig speichern, damit der Stand erhalten bleibt,
  falls Render neu startet.
*/
setInterval(() => {
  speichereDaten();
}, 10000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});