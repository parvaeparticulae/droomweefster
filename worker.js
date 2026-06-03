// ============================================================
// Droomweefster — Cloudflare Worker
// Ontvangt droomparameters, roept DeepSeek aan, geeft verhaal terug.
// Het Worker-script verbergt de DeepSeek API-sleutel; die staat als
// "secret" in de Cloudflare-instellingen, niet in de code.
// ============================================================

// === Welke websites mogen deze Worker aanroepen? ===
// Alleen jouw eigen site. Zo kan iemand anders de Worker niet
// inbouwen in een vreemde pagina om jouw budget op te maken.
const ALLOWED_ORIGINS = [
  "https://parvaeparticulae.github.io",
];

// === Rate limit: maximaal X verhalen per IP per dag ===
const LIMIT_PER_DAY = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

// Eenvoudige in-memory teller. Niet 100% waterdicht (reset
// bij Worker-restart), maar prima voor onze schaal.
const rateLimit = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > DAY_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  if (entry.count >= LIMIT_PER_DAY) return false;
  entry.count++;
  rateLimit.set(ip, entry);
  return true;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function jsonResponse(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Alleen POST toegestaan" }, 405, origin);
    }

    // Rate limit
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRateLimit(ip)) {
      return jsonResponse(
        { error: `Je hebt het dagelijkse limiet van ${LIMIT_PER_DAY} verhalen bereikt. Probeer morgen opnieuw.` },
        429,
        origin
      );
    }

    // Parse input
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Ongeldig verzoek (geen geldige JSON)" }, 400, origin);
    }

    const dream = body?.dream;
    if (!dream || typeof dream !== "object") {
      return jsonResponse({ error: "Geen droomgegevens ontvangen" }, 400, origin);
    }

    // Sleutel aanwezig?
    if (!env.DEEPSEEK_API_KEY) {
      return jsonResponse({ error: "AI-sleutel niet geconfigureerd op de server" }, 500, origin);
    }

    // === Prompt opbouwen ===
    const lengthWords = { "1": 250, "2": 550, "3": 1100 };
    const targetWords = lengthWords[String(dream.length)] || 550;

    const explicitnessNotes = {
      "1": "Suggestief en poëtisch. Vermijd directe seksuele termen, gebruik metaforen, sensualiteit en sfeer.",
      "2": "Suggestief maar levendig. Beschrijf gevoelens en handelingen zonder al te direct te zijn.",
      "3": "Eerlijk en zintuiglijk. Beschrijf wat gebeurt op een natuurlijke manier, niets verbloemen maar ook niet onnodig grof.",
      "4": "Direct en expliciet. Gebruik concrete seksuele taal en gedetailleerde beschrijvingen van handelingen en gevoelens.",
      "5": "Volledig expliciet, geen enkel detail verbloemen. Gebruik rauwe, directe seksuele taal — alles benoemen bij naam.",
    };
    const explNote = explicitnessNotes[String(dream.explicitness)] || explicitnessNotes["3"];

    const systemPrompt = `Je bent een ervaren schrijver van Nederlandstalige erotische fictie. Schrijf een meeslepend, zintuiglijk verhaal op basis van de droomparameters die de gebruiker aanlevert.

REGELS:
- Schrijf in vlot, natuurlijk Nederlands.
- Schrijf in de tweede persoon enkelvoud (jij/je-perspectief — de lezer is de hoofdpersoon).
- Doel: ongeveer ${targetWords} woorden.
- Expliciteit: ${explNote}
- Alle personen zijn volwassen (18+).
- Geen disclaimers, waarschuwingen, meta-commentaar of titel — alleen het verhaal zelf in lopende prozatekst.
- Begin met een zintuiglijke opening, bouw spanning op, lever de gewenste climax en sluit af met een korte naklank.
- Verweef de aangegeven kinks, dynamiek en sfeer natuurlijk in het verhaal — som ze niet op, laat ze dóór de scène lopen.
- Schrijf in losse alinea's (geen kopjes, geen lijstjes).

LOCATIE-COHERENTIE (heel belangrijk):
- De locatie is de fysieke werkelijkheid van de scène. Gebruik alleen elementen die er logisch passen.
- Kantoor/werkplek: denk aan bureaus, vergaderzalen, kopieerruimtes, archief- of bergruimtes, een vergrendelde deur, het zoemen van een airco, de spanning dat een collega kan binnenkomen. Geen haard, geen bed, geen lakens.
- Feest/club: donkere hoeken, een toiletcabine, een verlaten kleedkamer, het bonkende ritme van muziek, dichte massa. Geen lakens, geen kaarslicht.
- Buiten/natuur: gras, boomstam, water, wind, vochtige aarde, gevoel van blootstelling.
- Slaapkamer/hotelkamer: bed, lakens, kussens, intimiteit van een gesloten kamer.
- Badkamer: stoom, druppels, marmer of tegels, water, spiegels.
- Als een sfeer- of kledingoptie op het eerste gezicht botst met de locatie, interpreteer 'm logisch zodat het wél past. Voorbeelden: "warmte" in een kantoor = lichaamswarmte of de gloed van een opwarmend lichaam, geen haard. "Lingerie" in een kantoor = zichtbaar onder een haastig opengeknoopte blouse. "Halsband" in werkkleding = subtiel onder een trui of colbert.
- Als de gebruiker aangeeft (deels) gekleed te blijven, respecteer dat: de scène speelt zich af mét kleding aan, niet zonder.`;

    const userPrompt = buildUserPrompt(dream);

    // === DeepSeek aanroepen ===
    try {
      const dsResp = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.9,
          max_tokens: Math.ceil(targetWords * 2.5),
        }),
      });

      if (!dsResp.ok) {
        const errTxt = await dsResp.text();
        return jsonResponse(
          { error: "AI-service gaf een fout", detail: errTxt.slice(0, 500) },
          502,
          origin
        );
      }

      const data = await dsResp.json();
      const story = data?.choices?.[0]?.message?.content?.trim() || "";

      if (!story) {
        return jsonResponse({ error: "Leeg antwoord van AI" }, 502, origin);
      }

      return jsonResponse({ story }, 200, origin);
    } catch (e) {
      return jsonResponse(
        { error: "Kon AI niet bereiken", detail: String(e?.message || e) },
        502,
        origin
      );
    }
  },
};

function buildUserPrompt(d) {
  const lines = ["Schrijf een erotisch droomverhaal met de volgende elementen:"];

  const loc = d.locationCustom || d.location;
  if (loc) lines.push(`\nLocatie: ${loc}`);
  if (Array.isArray(d.moment) && d.moment.length) lines.push(`Moment: ${d.moment.join(", ")}`);
  if (Array.isArray(d.light) && d.light.length) lines.push(`Verlichting: ${d.light.join(", ")}`);
  if (Array.isArray(d.senses) && d.senses.length) lines.push(`Sfeer / zintuigen: ${d.senses.join(", ")}`);

  const selfParts = [];
  if (Array.isArray(d.selfClothing) && d.selfClothing.length) selfParts.push(`draagt ${d.selfClothing.join(" en ")}`);
  if (Array.isArray(d.selfLook) && d.selfLook.length) selfParts.push(`uiterlijk: ${d.selfLook.join(", ")}`);
  if (Array.isArray(d.selfMood) && d.selfMood.length) selfParts.push(`voelt zich ${d.selfMood.join(" en ")}`);
  if (selfParts.length) lines.push(`\nIk (de hoofdpersoon): ${selfParts.join("; ")}`);
  if (d.selfExtra) lines.push(`Extra over mezelf: ${d.selfExtra}`);

  const whoLabels = {
    partner: "mijn partner",
    onbekende: "een mysterieuze onbekende",
    bekende: "een bekend persoon (acteur, zanger, sporter of model)",
    kennis: "iemand die ik ken (vriend, collega, buurman)",
    fictief: "een fictief personage",
    meerdere: "meerdere personen tegelijk",
  };
  const whoText = whoLabels[d.who] || "iemand";
  let otherLine = `\nDe ander: ${whoText}`;
  if (d.whoName) otherLine += ` (naam: ${d.whoName})`;
  lines.push(otherLine);
  if (d.whoDetail) lines.push(`Beschrijving van de ander: ${d.whoDetail}`);
  if (Array.isArray(d.otherBody) && d.otherBody.length) lines.push(`Lichaamsbouw: ${d.otherBody.join(", ")}`);
  if (Array.isArray(d.otherVibe) && d.otherVibe.length) lines.push(`Uitstraling: ${d.otherVibe.join(", ")}`);
  if (Array.isArray(d.otherClothing) && d.otherClothing.length) lines.push(`Kleding: ${d.otherClothing.join(", ")}`);
  if (Array.isArray(d.otherVoice) && d.otherVoice.length) lines.push(`Stem / communicatie: ${d.otherVoice.join(", ")}`);
  if (d.otherExtra) lines.push(`Extra over de ander: ${d.otherExtra}`);

  const dynLabels = {
    "ik onderwerpend": "Ik geef me over; hij/zij bepaalt en ik volg",
    "ik dominant": "Ik neem de leiding en de ander gehoorzaamt",
    "gelijkwaardig": "Gelijkwaardig, samen ontdekkend, om de beurt leidend",
    "wisselend": "Wisselende machtsbalans gedurende het verhaal",
  };
  if (d.dynamic) lines.push(`\nDynamiek: ${dynLabels[d.dynamic] || d.dynamic} (intensiteit ${d.intensity}/5)`);

  if (Array.isArray(d.kinks) && d.kinks.length) lines.push(`\nElementen om natuurlijk in te verweven: ${d.kinks.join(", ")}`);
  if (d.kinksExtra) lines.push(`Extra wensen rond elementen: ${d.kinksExtra}`);

  const opening = d.openingExtra || d.opening;
  if (opening) lines.push(`\nOpenscène: ${opening}`);
  if (Array.isArray(d.escalation) && d.escalation.length) lines.push(`Spanning bouwt op via: ${d.escalation.join(", ")}`);
  const climax = d.climaxExtra || d.climax;
  if (climax) lines.push(`Climax: ${climax}`);

  if (d.extra) lines.push(`\nBelangrijke aanvullende notities: ${d.extra}`);

  return lines.join("\n");
}
