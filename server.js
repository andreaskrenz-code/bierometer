const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const https = require("https");

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
  Lernende Gewichtung:
  Die App schaut auf die Fasswechsel der letzten 2 Stunden.
  Dadurch lernt sie, welche Zapfstelle stärker frequentiert ist.

  Wichtig:
  Das erhöht NICHT den Gesamtverbrauch.
  Es verteilt nur den bestehenden Gesamtverbrauch realistischer auf die Zapfstellen.
*/
const LERNFENSTER_MS = 2 * 60 * 60 * 1000;
const MIN_LERNFAKTOR = 0.5;
const MAX_LERNFAKTOR = 2.5;

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
  Wetter Schützenplatz Paderborn
  Koordinaten ungefähr Schützenplatz / Schützenhof Paderborn.
*/
const WETTER_LAT = 51.73014;
const WETTER_LON = 8.74928;
const WETTER_AKTUALISIERUNG_MS = 5 * 60 * 1000;

let wetter = {
  ok: false,
  text: "Wetter wird geladen...",
  emoji: "🌤️",
  temperatur: null,
  wind: null,
  regen: null,
  code: null,
  aktualisiertUm: null
};



let setupAbgeschlossen = false;
let zapfstellenKonfig = [];

let plan = 0;
let ist = 0;
let anzeigeIst = 0;
let anzeigeLaeuft = false;
let turboBis = 0;
let autoAufholLiter = 0;
let startTime = Date.now();

let tickerText = "🍺 Hol noch eine Runde!";

let tickerTexte = [
  "🍺 Hol noch eine Runde!",
  "Der Durst zählt mit!",
  "Prost Königsträsser!",
  "Noch ein Bier fürs Bierometer!",
  "Heute zählt jeder Liter!",
  "Ein Bier geht noch!",
  "Frisch gezapft schmeckt am besten!",
  "Das Bierometer braucht Futter!",
  "Königsträsser, gebt Gas!",
  "Runde für die Theke!"
];

let newsAktiv = false;
let newsText = "";

let newsAutoAusMinuten = 10;
let newsAutoAusUm = null;
let newsAutoAusTimer = null;
let newsTitel = "Wichtige Info";

let zapfstellen = {};
let buchungen = [];

function bereinigeTickerTexte(wert) {
  let zeilen = [];

  if (Array.isArray(wert)) {
    zeilen = wert;
  } else {
    zeilen = String(wert || "").split(/\r?\n/);
  }

  zeilen = zeilen
    .map(text => String(text || "").trim())
    .filter(Boolean)
    .map(text => text.slice(0, 140));

  if (zeilen.length > 80) {
    zeilen = zeilen.slice(0, 80);
  }

  if (zeilen.length === 0) {
    zeilen = ["🍺 Hol noch eine Runde!"];
  }

  return zeilen;
}

function begrenze(wert, min, max) {
  return Math.min(max, Math.max(min, wert));
}

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
    anzeigeLiter: 0,

    /*
      Hier merkt sich die App, wann an dieser Zapfstelle Fässer gewechselt wurden.
      Daraus wird später die gelernte Gewichtung berechnet.
    */
    fassWechselHistorie: []
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

    if (!Array.isArray(zapfstellen[id].fassWechselHistorie)) {
      zapfstellen[id].fassWechselHistorie = [];
    }

    if (zapfstellen[id].anzeigeLiter > zapfstellen[id].liter) {
      zapfstellen[id].anzeigeLiter = zapfstellen[id].liter;
    }

    bereinigeFassWechselHistorie(id);
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

function erstelleBuchungsId() {
  return `buchung-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function erstelleBuchung({ stelle, liter, typ, stornoVon = null }) {
  return {
    id: erstelleBuchungsId(),
    zeit: new Date().toISOString(),
    stelle,
    liter,
    typ,
    stornoVon,
    storniert: false,
    storniertAm: null
  };
}

function istStornierbareBuchung(buchung) {
  return buchung &&
    !buchung.storniert &&
    !buchung.stornoVon &&
    (
      buchung.typ === "fass30" ||
      buchung.typ === "fass50" ||
      buchung.typ === "frei"
    );
}

function bereinigeFassWechselHistorie(stelle) {
  const z = zapfstellen[stelle];

  if (!z || !Array.isArray(z.fassWechselHistorie)) {
    return;
  }

  const grenze = Date.now() - LERNFENSTER_MS;

  z.fassWechselHistorie = z.fassWechselHistorie.filter(eintrag => {
    const zeit = new Date(eintrag.zeit).getTime();
    return Number.isFinite(zeit) && zeit >= grenze;
  });
}

function registriereFassWechsel(stelle, liter) {
  const z = zapfstellen[stelle];

  if (!z) {
    return;
  }

  if (!Array.isArray(z.fassWechselHistorie)) {
    z.fassWechselHistorie = [];
  }

  z.fassWechselHistorie.push({
    zeit: new Date().toISOString(),
    liter
  });

  bereinigeFassWechselHistorie(stelle);
}

function entferneFassWechselAusHistorie(stelle, liter) {
  const z = zapfstellen[stelle];

  if (!z || !Array.isArray(z.fassWechselHistorie)) {
    return;
  }

  /*
    Bei Storno entfernen wir den zuletzt gefundenen passenden Fasswechsel.
  */
  for (let i = z.fassWechselHistorie.length - 1; i >= 0; i--) {
    const eintrag = z.fassWechselHistorie[i];

    if (Number(eintrag.liter) === Number(liter)) {
      z.fassWechselHistorie.splice(i, 1);
      return;
    }
  }
}

function getFassWechselStats(stelle) {
  const z = zapfstellen[stelle];

  if (!z || !Array.isArray(z.fassWechselHistorie)) {
    return {
      anzahl: 0,
      liter: 0
    };
  }

  bereinigeFassWechselHistorie(stelle);

  const liter = z.fassWechselHistorie.reduce((summe, eintrag) => {
    return summe + (Number(eintrag.liter) || 0);
  }, 0);

  return {
    anzahl: z.fassWechselHistorie.length,
    liter
  };
}

function berechneGewichtungsInfo() {
  /*
    Hier wird gelernt:
    Die Fasswechsel-Liter der letzten 2 Stunden werden pro Zapfstelle betrachtet.
    Hat eine Zapfstelle überdurchschnittlich viele Fasswechsel, bekommt sie einen höheren Lernfaktor.
    Hat sie wenig oder keine Wechsel, bekommt sie einen niedrigeren Faktor.

    Die Summe des Verbrauchs bleibt trotzdem gleich.
  */
  const statsMap = {};
  let gesamtLiterImFenster = 0;

  for (const config of zapfstellenKonfig) {
    const stats = getFassWechselStats(config.id);
    statsMap[config.id] = stats;
    gesamtLiterImFenster += stats.liter;
  }

  const anzahlZapfstellen = Math.max(zapfstellenKonfig.length, 1);
  const durchschnittLiter = gesamtLiterImFenster / anzahlZapfstellen;

  const info = {};

  for (const config of zapfstellenKonfig) {
    const basisGewicht = Number(config.gewicht || 1);
    const stats = statsMap[config.id] || { anzahl: 0, liter: 0 };

    let lernfaktor = 1;

    if (gesamtLiterImFenster > 0 && durchschnittLiter > 0) {
      lernfaktor = stats.liter / durchschnittLiter;
      lernfaktor = begrenze(lernfaktor, MIN_LERNFAKTOR, MAX_LERNFAKTOR);
    }

    const effektivesGewicht = basisGewicht * lernfaktor;

    info[config.id] = {
      basisGewicht,
      lernfaktor,
      effektivesGewicht,
      fasswechselAnzahlLernfenster: stats.anzahl,
      fasswechselLiterLernfenster: stats.liter
    };
  }

  return info;
}

function planeNewsAutoAus() {
  if (newsAutoAusTimer) {
    clearTimeout(newsAutoAusTimer);
    newsAutoAusTimer = null;
  }

  if (!newsAktiv || !newsAutoAusUm) {
    return;
  }

  const restMs = newsAutoAusUm - Date.now();

  if (restMs <= 0) {
    newsAktiv = false;
    newsAutoAusUm = null;

    speichereDaten();
    sendeUpdate();
    return;
  }

  newsAutoAusTimer = setTimeout(() => {
    newsAktiv = false;
    newsAutoAusUm = null;
    newsAutoAusTimer = null;

    speichereDaten();
    sendeUpdate();
  }, restMs);
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
    if (Array.isArray(daten.tickerTexte)) {
  tickerTexte = bereinigeTickerTexte(daten.tickerTexte);
  tickerText = tickerTexte[0] || "🍺 Hol noch eine Runde!";
} else if (typeof daten.tickerText === "string") {
  tickerText = daten.tickerText;
  tickerTexte = bereinigeTickerTexte(daten.tickerText);
}

if (typeof daten.newsAktiv === "boolean") {
  newsAktiv = daten.newsAktiv;
}

if (typeof daten.newsTitel === "string") {
  newsTitel = daten.newsTitel;
}

if (typeof daten.newsText === "string") {
  newsText = daten.newsText;
}

if (typeof daten.newsAutoAusMinuten === "number") {
  newsAutoAusMinuten = Math.max(0, Math.min(120, daten.newsAutoAusMinuten));
}

if (typeof daten.newsAutoAusUm === "number") {
  newsAutoAusUm = daten.newsAutoAusUm;
}

if (newsAktiv && newsAutoAusUm && Date.now() >= newsAutoAusUm) {
  newsAktiv = false;
  newsAutoAusUm = null;
}

    if (anzeigeIst > ist) {
      anzeigeIst = ist;
    }

    if (daten.zapfstellen && typeof daten.zapfstellen === "object") {
      zapfstellen = daten.zapfstellen;
    }

    if (Array.isArray(daten.buchungen)) {
      buchungen = daten.buchungen.slice(-100).map(buchung => {
        return {
          id: buchung.id || erstelleBuchungsId(),
          zeit: buchung.zeit || new Date().toISOString(),
          stelle: Number(buchung.stelle),
          liter: Number(buchung.liter) || 0,
          typ: buchung.typ || "frei",
          stornoVon: buchung.stornoVon || null,
          storniert: Boolean(buchung.storniert),
          storniertAm: buchung.storniertAm || null
        };
      });
    }

        sichereZapfstellenStruktur();
    planeNewsAutoAus();
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
      wetter,
      tickerText,
      tickerTexte,
      newsAktiv,
newsTitel,
newsText,
newsAutoAusMinuten,
newsAutoAusUm,


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

  /*
    Die sichtbare Verbrauchsgeschwindigkeit kommt NUR aus dem Festplan.
    Mehr angestochene Fässer dürfen den Gesamtverbrauch NICHT beschleunigen.
  */
  let speed = Number(live.literProStunde) || 0;

  /*
    Nur manuelles AUFHOLEN darf schneller laufen.
  */
  if (Date.now() < turboBis) {
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
  const gewichtungsInfo = berechneGewichtungsInfo();

  const speedMap = {};

  for (const config of zapfstellenKonfig) {
    speedMap[config.id] = 0;
  }

  const summeEffektiveGewichte = aktiveZapfstellen.reduce((summe, config) => {
    const info = gewichtungsInfo[config.id];
    return summe + Number(info?.effektivesGewicht || config.gewicht || 1);
  }, 0);

  if (gesamtSpeed <= 0 || summeEffektiveGewichte <= 0) {
    return speedMap;
  }

  for (const config of aktiveZapfstellen) {
    const info = gewichtungsInfo[config.id];
    const effektivesGewicht = Number(info?.effektivesGewicht || config.gewicht || 1);

    speedMap[config.id] = gesamtSpeed * (effektivesGewicht / summeEffektiveGewichte);
  }

  return speedMap;
}

function getZapfstellenPrognose() {
  const live = getLiveParameter();
  const speedMap = berechneSpeedProZapfstelle();
  const gewichtungsInfo = berechneGewichtungsInfo();

  const prognose = {};

  for (const config of zapfstellenKonfig) {
    const id = config.id;
    const z = zapfstellen[id] || erstelleLeereZapfstelle();
    const info = gewichtungsInfo[id] || {
      basisGewicht: Number(config.gewicht || 1),
      lernfaktor: 1,
      effektivesGewicht: Number(config.gewicht || 1),
      fasswechselAnzahlLernfenster: 0,
      fasswechselLiterLernfenster: 0
    };

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

      /*
        Alte Anzeige-Kompatibilität:
        gewicht bleibt erhalten, entspricht dem Grundgewicht.
      */
      gewicht: Number(info.basisGewicht.toFixed(2)),

      basisGewicht: Number(info.basisGewicht.toFixed(2)),
      lernfaktor: Number(info.lernfaktor.toFixed(2)),
      effektivesGewicht: Number(info.effektivesGewicht.toFixed(2)),
      fasswechselAnzahlLernfenster: info.fasswechselAnzahlLernfenster,
      fasswechselLiterLernfenster: Number(info.fasswechselLiterLernfenster.toFixed(1)),
      lernfensterMinuten: Math.round(LERNFENSTER_MS / 60 / 1000),

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

function holeJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      let data = "";

      response.on("data", chunk => {
        data += chunk;
      });

      response.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

function getWetterEmoji(code, isDay) {
  const tag = Number(isDay) === 1;

  if (code === 0) {
    return tag ? "☀️" : "🌙";
  }

  if ([1, 2].includes(code)) {
    return tag ? "🌤️" : "☁️";
  }

  if (code === 3) {
    return "☁️";
  }

  if ([45, 48].includes(code)) {
    return "🌫️";
  }

  if ([51, 53, 55, 56, 57].includes(code)) {
    return "🌦️";
  }

  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return "🌧️";
  }

  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return "❄️";
  }

  if ([95, 96, 99].includes(code)) {
    return "⛈️";
  }

  return "🌤️";
}

function getWetterBeschreibung(code) {
  if (code === 0) return "klar";
  if ([1, 2].includes(code)) return "leicht bewölkt";
  if (code === 3) return "bewölkt";
  if ([45, 48].includes(code)) return "neblig";
  if ([51, 53, 55, 56, 57].includes(code)) return "Nieselregen";
  if ([61, 63, 65].includes(code)) return "Regen";
  if ([66, 67].includes(code)) return "gefrierender Regen";
  if ([71, 73, 75, 77].includes(code)) return "Schnee";
  if ([80, 81, 82].includes(code)) return "Regenschauer";
  if ([85, 86].includes(code)) return "Schneeschauer";
  if ([95, 96, 99].includes(code)) return "Gewitter";

  return "Wetter";
}

function baueWetterText({ temperatur, wind, regen, code, isDay }) {
  const emoji = getWetterEmoji(code, isDay);
  const beschreibung = getWetterBeschreibung(code);

  const tempText = Number.isFinite(temperatur)
    ? `${Math.round(temperatur)}°C`
    : "--°C";

  const windText = Number.isFinite(wind)
    ? `Wind ${Math.round(wind)} km/h`
    : "Wind -- km/h";

  const regenText = Number.isFinite(regen)
    ? `Regen ${Number(regen).toLocaleString("de-DE", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      })} mm`
    : "Regen -- mm";

  if (Number(regen) > 0.2 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(code)) {
    return `${emoji} ${tempText}   ${beschreibung} am Schützenplatz   ${windText}   ${regenText}   Schnell noch ein Bier sichern! 🍺`;
  }

  if (Number(temperatur) >= 22) {
    return `${emoji} ${tempText}   Bestes Bierwetter am Schützenplatz   ${windText}   ${regenText}   Hol noch eine Runde! 🍺`;
  }

  return `${emoji} ${tempText}   Wetter Schützenplatz Paderborn: ${beschreibung}   ${windText}   ${regenText}`;
}

async function aktualisiereWetter() {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${WETTER_LAT}` +
      `&longitude=${WETTER_LON}` +
      `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,is_day` +
      `&timezone=Europe%2FBerlin`;

    const daten = await holeJSON(url);
    const current = daten.current || {};

    const temperatur = Number(current.temperature_2m);
    const wind = Number(current.wind_speed_10m);
    const regen = Number(current.precipitation);
    const code = Number(current.weather_code);
    const isDay = Number(current.is_day);

    wetter = {
      ok: true,
      text: baueWetterText({
        temperatur,
        wind,
        regen,
        code,
        isDay
      }),
      emoji: getWetterEmoji(code, isDay),
      beschreibung: getWetterBeschreibung(code),
      temperatur,
      wind,
      regen,
      code,
      isDay,
      aktualisiertUm: new Date().toISOString()
    };

    sendeUpdate();
  } catch (err) {
    console.error("Wetter konnte nicht geladen werden:", err.message);

    wetter = {
      ...wetter,
      ok: false,
      text: "Wetterdaten gerade nicht verfügbar",
      aktualisiertUm: new Date().toISOString()
    };
  }
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

    tickerText,
    tickerTexte,

    newsAktiv,
newsTitel,
newsText,
newsAutoAusMinuten,
newsAutoAusUm,
newsAutoAusRestMs: newsAutoAusUm ? Math.max(0, newsAutoAusUm - Date.now()) : null,
wetter,

    serverTime: Date.now(),
    averageLiterPerMs: getAverageLiterPerMs(),

    live: getLiveParameter(),
    aktuelleAnzeigeGeschwindigkeit: berechneAnzeigeGeschwindigkeit(),

    wetter,

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
    /*
      Wenn ein neues Fass bestätigt wird, war das alte echte Fass leer.

      Der rechnerische Rest des alten Fasses ist also tatsächlich schon verbraucht.
      Wichtig:
      Dieser Rest ist im Gesamt-IST bereits enthalten, weil das alte Fass ja schon
      beim Anstich gebucht wurde.

      Deshalb wird der Rest NICHT nochmal auf ist addiert.
      Er wird nur auf die sichtbare Bierometer-Anzeige anzeigeIst addiert.
    */
    const rechnerischerRestAltesFass = Math.max(0, z.liter - z.anzeigeLiter);

    if (rechnerischerRestAltesFass > 0.1) {
      anzeigeIst += rechnerischerRestAltesFass;

      /*
        Sicherheit: Die sichtbare Anzeige darf nie über dem echten IST liegen.
      */
      if (anzeigeIst > ist) {
        anzeigeIst = ist;
      }

      buchungen.push(erstelleBuchung({
        stelle,
        liter: Number(rechnerischerRestAltesFass.toFixed(1)),
        typ: "restVerbraucht"
      }));
    }

    /*
      Jetzt wird das neue Fass gebucht.
      Das erhöht den echten Gesamt-IST um 30 oder 50 Liter.
    */
    ist += liter;

    /*
      Für die Füllstandsanzeige startet diese Zapfstelle wieder beim neuen Fass.
      Also nicht alter Rest + neues Fass, sondern exakt 30 L oder 50 L.
    */
    z.liter = liter;
    z.anzeigeLiter = 0;

    if (typ === "fass30") {
      z.faesser30 += 1;
    }

    if (typ === "fass50") {
      z.faesser50 += 1;
    }

    registriereFassWechsel(stelle, liter);
  }

  if (typ === "frei") {
    /*
      Freie Eingaben bleiben Zusatzbuchungen.
    */
    ist += liter;

    if (anzeigeIst > ist) {
      anzeigeIst = ist;
    }

    z.liter += liter;
    z.freieEingaben += 1;
  }

  buchungen.push(erstelleBuchung({
    stelle,
    liter,
    typ
  }));

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

  /*
    Mehrere Runden, damit Rest neu verteilt wird,
    falls eine Zapfstelle während der Verteilung leer wird.
  */
  for (let runde = 0; runde < 10; runde++) {
    if (rest <= 0.0001) {
      break;
    }

    const aktive = getAktiveZapfstellenMitRest();

    if (!aktive.length) {
      break;
    }

    const gewichtungsInfo = berechneGewichtungsInfo();

    const summeGewichte = aktive.reduce((summe, config) => {
      const info = gewichtungsInfo[config.id];
      return summe + Number(info?.effektivesGewicht || config.gewicht || 1);
    }, 0);

    if (summeGewichte <= 0) {
      break;
    }

    let verteilt = 0;

    for (const config of aktive) {
      const z = zapfstellen[config.id];
      const offen = Math.max(0, z.liter - z.anzeigeLiter);

      const info = gewichtungsInfo[config.id];
      const effektivesGewicht = Number(info?.effektivesGewicht || config.gewicht || 1);

      const anteilSoll = rest * (effektivesGewicht / summeGewichte);
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

app.post("/api/ticker", (req, res) => {
  const text = String(req.body.text || "").trim();

  const neueTickerTexte = bereinigeTickerTexte(text);

  tickerTexte = neueTickerTexte;
  tickerText = tickerTexte[0] || "🍺 Hol noch eine Runde!";

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    ...getStatus()
  });
});

app.post("/api/news", (req, res) => {
  const aktiv = Boolean(req.body.aktiv);

  let titel = String(req.body.titel || "Wichtige Info").trim();
  let text = String(req.body.text || "").trim();

  let autoAusMinuten = Number(
    req.body.autoAusMinuten ?? newsAutoAusMinuten
  );

  if (!Number.isFinite(autoAusMinuten)) {
    autoAusMinuten = newsAutoAusMinuten;
  }

  autoAusMinuten = Math.max(0, Math.min(120, autoAusMinuten));

  if (!titel) {
    titel = "Wichtige Info";
  }

  if (titel.length > 40) {
    return res.status(400).send("News-Titel ist zu lang. Maximal 40 Zeichen.");
  }

  if (text.length > 220) {
    return res.status(400).send("News-Text ist zu lang. Maximal 220 Zeichen.");
  }

  if (aktiv && !text) {
    return res.status(400).send("Bitte einen News-Text eingeben.");
  }

  newsAktiv = aktiv;
  newsTitel = titel;
  newsText = text;
  newsAutoAusMinuten = autoAusMinuten;

  if (newsAktiv && newsAutoAusMinuten > 0) {
    newsAutoAusUm = Date.now() + (newsAutoAusMinuten * 60 * 1000);
  } else {
    newsAutoAusUm = null;
  }

  planeNewsAutoAus();
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

app.post("/api/storno", (req, res) => {
  const id = String(req.body.id || "");

  const buchung = buchungen.find(eintrag => eintrag.id === id);

  if (!buchung) {
    return res.status(404).send("Buchung nicht gefunden");
  }

  if (!istStornierbareBuchung(buchung)) {
    return res.status(400).send("Diese Buchung kann nicht storniert werden");
  }

  const stelle = Number(buchung.stelle);
  const liter = Number(buchung.liter) || 0;
  const typ = buchung.typ;

  if (!istGueltigeZapfstelle(stelle)) {
    return res.status(400).send("Zapfstelle der Buchung ist ungültig");
  }

  if (liter <= 0) {
    return res.status(400).send("Buchung hat keinen gültigen Literwert");
  }

  const z = zapfstellen[stelle];

  if (!z) {
    return res.status(400).send("Zapfstelle nicht gefunden");
  }

  ist = Math.max(0, ist - liter);
  z.liter = Math.max(0, z.liter - liter);

  if (typ === "fass30") {
    z.faesser30 = Math.max(0, z.faesser30 - 1);
    entferneFassWechselAusHistorie(stelle, liter);
  }

  if (typ === "fass50") {
    z.faesser50 = Math.max(0, z.faesser50 - 1);
    entferneFassWechselAusHistorie(stelle, liter);
  }

  if (typ === "frei") {
    z.freieEingaben = Math.max(0, z.freieEingaben - 1);
  }

  if (anzeigeIst > ist) {
    anzeigeIst = ist;
  }

  if (z.anzeigeLiter > z.liter) {
    z.anzeigeLiter = z.liter;
  }

  const maximalerRueckstand = Math.max(0, ist - anzeigeIst);

  if (autoAufholLiter > maximalerRueckstand) {
    autoAufholLiter = maximalerRueckstand;
  }

  buchung.storniert = true;
  buchung.storniertAm = new Date().toISOString();

  buchungen.push(erstelleBuchung({
    stelle,
    liter: -liter,
    typ: "storno",
    stornoVon: buchung.id
  }));

  if (buchungen.length > 100) {
    buchungen = buchungen.slice(-100);
  }

  speichereDaten();
  sendeUpdate();

  res.json({
    ok: true,
    storniert: buchung.id,
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

aktualisiereWetter();

setInterval(() => {
  aktualisiereWetter();
}, WETTER_AKTUALISIERUNG_MS);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});