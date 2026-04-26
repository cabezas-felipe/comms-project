export type Geography = "US" | "Colombia";
export type Topic = "Diplomatic relations" | "Migration policy" | "Security cooperation";
export type SourceKind = "traditional" | "social";

export interface Source {
  id: string;
  outlet: string;
  /** byline for traditional, handle for social */
  byline?: string;
  kind: SourceKind;
  /** 0-100; higher = more authoritative for ranking key sources */
  weight: number;
  url: string;
  minutesAgo: number;
  /** in-app article */
  headline: string;
  body: string[];
}

export interface Story {
  id: string;
  title: string;
  geographies: Geography[];
  topic: Topic;
  /** one-line takeaway shown on the card */
  takeaway: string;
  summary: string;
  whyItMatters: string;
  whatChanged: string;
  priority: "top" | "standard";
  outletCount: number;
  sources: Source[];
}

export const STORIES: Story[] = [
  {
    id: "ofac-colombia",
    title: "OFAC scrutiny expands around Colombia leadership narrative",
    geographies: ["US", "Colombia"],
    topic: "Diplomatic relations",
    takeaway:
      "Story is moving from policy reporting into political reaction — response cycle likely within the day.",
    summary:
      "Coverage across US and Colombian outlets frames possible sanctions implications and response pressure. Narrative is widening from policy reporting to political reaction.",
    whyItMatters:
      "A pivot from policy framing to political reaction signals the story is moving toward a response cycle — comms posture should be prepared, not reactive.",
    whatChanged: "Two major outlets added legal-context framing in the last hour.",
    priority: "top",
    outletCount: 14,
    sources: [
      {
        id: "ofac-nyt",
        outlet: "The New York Times",
        byline: "By Maria Hernandez",
        kind: "traditional",
        weight: 95,
        url: "#",
        minutesAgo: 20,
        headline: "Treasury Weighs Expanded Scrutiny of Colombia Officials",
        body: [
          "WASHINGTON — The Treasury Department's Office of Foreign Assets Control is examining a broader set of names tied to Colombia's leadership circle, according to three people briefed on the review.",
          "The internal assessment does not yet contemplate sanctions, the people said, but it widens the scope of an inquiry that began as a narrow policy question. It now sits with senior officials at State and Treasury, who must decide whether to escalate.",
          "A spokesperson for OFAC declined to comment. The Colombian embassy did not immediately respond to a request for comment.",
        ],
      },
      {
        id: "ofac-wapo",
        outlet: "The Washington Post",
        byline: "By David Chen",
        kind: "traditional",
        weight: 90,
        url: "#",
        minutesAgo: 34,
        headline: "Sanctions Question Reopens a Bilateral Strain",
        body: [
          "A quiet review inside the Treasury has spilled into the bilateral conversation between Washington and Bogotá, raising the political temperature on a relationship both governments had spent months stabilizing.",
          "Officials in both capitals describe the moment as fragile but not yet broken. What changes next, several said, depends on whether the review stays administrative or becomes a public-facing decision.",
        ],
      },
      {
        id: "ofac-elpais",
        outlet: "El País",
        byline: "Por Lucía Ramírez",
        kind: "traditional",
        weight: 80,
        url: "#",
        minutesAgo: 50,
        headline: "Bogotá observa con cautela la revisión de Washington",
        body: [
          "El gobierno colombiano sigue de cerca una revisión interna del Departamento del Tesoro estadounidense que, según funcionarios consultados, podría tener implicaciones políticas más amplias que las técnicas.",
          "Fuentes de la Cancillería describen el momento como delicado pero manejable, siempre que el proceso se mantenga en el plano administrativo.",
        ],
      },
      {
        id: "ofac-reuters",
        outlet: "Reuters",
        byline: "By Reuters Staff",
        kind: "traditional",
        weight: 88,
        url: "#",
        minutesAgo: 62,
        headline: "U.S. Treasury Reviewing Colombia-Linked Names, Sources Say",
        body: [
          "The U.S. Treasury is reviewing a list of Colombia-linked individuals as part of a broader compliance examination, three sources familiar with the matter told Reuters on Tuesday.",
          "The review remains preliminary and may not result in any action, the sources cautioned.",
        ],
      },
      {
        id: "ofac-eltiempo",
        outlet: "El Tiempo",
        byline: "Por Andrés Mora",
        kind: "traditional",
        weight: 75,
        url: "#",
        minutesAgo: 78,
        headline: "Crece la presión política en torno a la revisión de OFAC",
        body: [
          "La conversación pública sobre la revisión que adelanta la OFAC pasó esta semana del lenguaje técnico al político, con reacciones de figuras del Congreso colombiano.",
          "Analistas consultados coinciden en que el cambio de tono adelanta una etapa de respuesta más visible.",
        ],
      },
      {
        id: "ofac-handle1",
        outlet: "@latamwatcher",
        byline: "Carlos Vega · 18.4k followers",
        kind: "social",
        weight: 55,
        url: "#",
        minutesAgo: 28,
        headline: "Thread: what the Treasury review actually changes",
        body: [
          "1/ A lot of takes today on the OFAC review, most of them missing the actual mechanism. Quick thread on what's procedurally different now vs last month.",
          "2/ The review moved from a single desk to a cross-agency working group. That's the structural change. Everything else downstream of that.",
          "3/ Doesn't mean sanctions. Does mean the question now has political owners on both sides.",
        ],
      },
    ],
  },
  {
    id: "deportation-rwanda",
    title: "US deportation-routing discussion involving Rwanda resurfaces",
    geographies: ["US", "Colombia"],
    topic: "Migration policy",
    takeaway:
      "Bilateral framing is back; expect inbound press questions for Colombia-adjacent statements within 24h.",
    summary:
      "Early signals from policy and regional outlets suggest renewed attention on deportation routing and bilateral implications.",
    whyItMatters:
      "Bilateral framing creates exposure for Colombia-adjacent statements; expect inbound questions within 24h.",
    whatChanged: "Local coverage volume increased and one new government statement appeared.",
    priority: "top",
    outletCount: 9,
    sources: [
      {
        id: "dep-reuters",
        outlet: "Reuters",
        byline: "By Reuters Staff",
        kind: "traditional",
        weight: 88,
        url: "#",
        minutesAgo: 15,
        headline: "Rwanda Routing Discussion Returns to U.S. Migration Debate",
        body: [
          "The idea of routing certain deportation cases through Rwanda has reappeared in U.S. policy discussions, two officials confirmed, reviving a proposal that had quieted earlier this year.",
          "The renewed interest, the officials said, is driven by capacity pressures rather than a settled policy direction.",
        ],
      },
      {
        id: "dep-semana",
        outlet: "Semana",
        byline: "Por equipo Semana",
        kind: "traditional",
        weight: 70,
        url: "#",
        minutesAgo: 41,
        headline: "Vuelve al debate la ruta migratoria por Ruanda",
        body: [
          "Una propuesta que parecía archivada, la de canalizar parte de las deportaciones estadounidenses a través de Ruanda, regresó esta semana a la conversación pública.",
          "Para Colombia, el tema es indirecto pero relevante: cualquier reorganización del sistema migratorio estadounidense termina afectando los flujos regionales.",
        ],
      },
      {
        id: "dep-ap",
        outlet: "Associated Press",
        byline: "By AP Staff",
        kind: "traditional",
        weight: 85,
        url: "#",
        minutesAgo: 55,
        headline: "Officials Confirm Renewed Look at Third-Country Routing",
        body: [
          "U.S. officials confirmed Tuesday that the administration is again examining third-country routing options as part of a broader effort to manage migration capacity.",
          "Rwanda is among the countries under discussion, though no agreement is imminent, officials said.",
        ],
      },
      {
        id: "dep-elespectador",
        outlet: "El Espectador",
        byline: "Por Sofía López",
        kind: "traditional",
        weight: 72,
        url: "#",
        minutesAgo: 88,
        headline: "El gobierno colombiano evita pronunciarse sobre la ruta a Ruanda",
        body: [
          "La Cancillería colombiana evitó este martes pronunciarse sobre la posible reactivación de un esquema de deportaciones a través de Ruanda, limitándose a decir que sigue el tema con atención.",
        ],
      },
      {
        id: "dep-handle1",
        outlet: "@migrationdesk",
        byline: "Priya Sharma · 9.2k followers",
        kind: "social",
        weight: 50,
        url: "#",
        minutesAgo: 22,
        headline: "Why Rwanda is back in the conversation today",
        body: [
          "Short version: capacity pressure at southern processing sites is forcing a re-look at every third-country option that was on the table last year.",
          "Rwanda is the loudest because of the UK precedent, but it's not the only one being discussed.",
        ],
      },
    ],
  },
  {
    id: "regional-security",
    title: "Regional security coordination debate grows after congressional comments",
    geographies: ["US"],
    topic: "Security cooperation",
    takeaway:
      "Debate framing — not policy framing — typically precedes opinion-page cycles. Worth tracking.",
    summary:
      "Commentary has shifted from isolated remarks to broader debate about diplomatic and security alignment.",
    whyItMatters:
      "Debate framing — not policy framing — typically precedes opinion-page cycles. Worth tracking through the next two updates.",
    whatChanged: "Social discussion accelerated and one mainstream source reframed the story.",
    priority: "standard",
    outletCount: 7,
    sources: [
      {
        id: "sec-politico",
        outlet: "Politico",
        byline: "By Jordan Wells",
        kind: "traditional",
        weight: 80,
        url: "#",
        minutesAgo: 12,
        headline: "Hill Comments Reignite Debate on Regional Security Posture",
        body: [
          "Comments from two senior lawmakers this morning have reopened a debate about the U.S. posture on regional security coordination, with allies and critics quickly staking out positions.",
          "The remarks themselves were modest. The reaction was not.",
        ],
      },
      {
        id: "sec-eltiempo",
        outlet: "El Tiempo",
        byline: "Por Andrés Mora",
        kind: "traditional",
        weight: 75,
        url: "#",
        minutesAgo: 38,
        headline: "Cooperación regional: ¿debate de fondo o pulso político?",
        body: [
          "El nuevo round del debate sobre coordinación de seguridad en la región tiene más de pulso político que de discusión sustantiva, según analistas consultados por este diario.",
        ],
      },
      {
        id: "sec-bloomberg",
        outlet: "Bloomberg",
        byline: "By Bloomberg News",
        kind: "traditional",
        weight: 82,
        url: "#",
        minutesAgo: 59,
        headline: "Markets Shrug as Security Debate Heats Up in Washington",
        body: [
          "Markets showed little reaction to a fresh round of debate over U.S. security coordination posture in the region, suggesting investors continue to view the discussion as political rather than operational.",
        ],
      },
    ],
  },
  {
    id: "trade-corridor",
    title: "Pacific trade corridor talks gain quiet traction in regional press",
    geographies: ["Colombia"],
    topic: "Diplomatic relations",
    takeaway:
      "Procedural framing now means political framing later. Establish a baseline summary before the cycle turns.",
    summary:
      "Regional outlets are previewing trade corridor working groups ahead of next month's bilateral schedule. Tone is procedural, not political.",
    whyItMatters:
      "Procedural framing now means political framing later. Establish a baseline summary before the cycle turns.",
    whatChanged: "Two regional outlets published explainer-format pieces in the past 90 minutes.",
    priority: "standard",
    outletCount: 5,
    sources: [
      {
        id: "trade-eltiempo",
        outlet: "El Tiempo",
        byline: "Por Camila Ortiz",
        kind: "traditional",
        weight: 75,
        url: "#",
        minutesAgo: 28,
        headline: "Corredor del Pacífico: lo que está sobre la mesa",
        body: [
          "El cronograma bilateral del próximo mes incluye al menos dos sesiones técnicas dedicadas al corredor de comercio del Pacífico, un tema que durante meses estuvo en pausa.",
          "Las delegaciones discutirán principalmente reglas operativas, no cifras.",
        ],
      },
      {
        id: "trade-sillavacia",
        outlet: "La Silla Vacía",
        byline: "Por equipo La Silla",
        kind: "traditional",
        weight: 65,
        url: "#",
        minutesAgo: 64,
        headline: "Por qué el corredor del Pacífico vuelve ahora",
        body: [
          "El regreso del tema al calendario bilateral responde menos a una decisión política que a la presión de los gremios exportadores, que llevan meses pidiendo claridad operativa.",
        ],
      },
      {
        id: "trade-bloomberg",
        outlet: "Bloomberg Línea",
        byline: "Por Bloomberg Línea",
        kind: "traditional",
        weight: 78,
        url: "#",
        minutesAgo: 110,
        headline: "Pacific Corridor Working Groups Return to Bilateral Agenda",
        body: [
          "Working groups on the Pacific trade corridor will return to the bilateral agenda next month, according to a draft schedule reviewed by Bloomberg Línea.",
        ],
      },
    ],
  },
  {
    id: "border-coordination",
    title: "Border coordination figures cited in two unrelated US opinion pieces",
    geographies: ["US"],
    topic: "Migration policy",
    takeaway:
      "Cross-spectrum citation usually predicts the dataset becoming a fixture in next-cycle coverage.",
    summary:
      "Same dataset is being used in opinion writing across the political spectrum, suggesting it will recur in next-cycle coverage.",
    whyItMatters:
      "Cross-spectrum citation usually predicts the dataset becoming a fixture in the next 48–72h.",
    whatChanged: "A third opinion piece referenced the same figures in the last update window.",
    priority: "standard",
    outletCount: 6,
    sources: [
      {
        id: "border-atlantic",
        outlet: "The Atlantic",
        byline: "By Jamie Reyes",
        kind: "traditional",
        weight: 78,
        url: "#",
        minutesAgo: 47,
        headline: "What the Border Numbers Don't Tell Us",
        body: [
          "The latest border coordination figures are getting cited everywhere this week, often without the context that makes them meaningful.",
          "Read carefully, they tell a more complicated story than either side seems to want.",
        ],
      },
      {
        id: "border-natreview",
        outlet: "National Review",
        byline: "By Mark Hollis",
        kind: "traditional",
        weight: 70,
        url: "#",
        minutesAgo: 95,
        headline: "Read the Border Coordination Numbers Carefully",
        body: [
          "The same dataset that critics of current policy are citing this week in fact undermines several of their broader claims, if read in full.",
        ],
      },
      {
        id: "border-wsj",
        outlet: "The Wall Street Journal",
        byline: "By WSJ Editorial Board",
        kind: "traditional",
        weight: 85,
        url: "#",
        minutesAgo: 133,
        headline: "A Border Dataset Worth Taking Seriously",
        body: [
          "A coordination dataset released last month is now showing up in commentary across the spectrum — for good reason. Both sides find something in it.",
        ],
      },
    ],
  },
];

export const TOPICS: Topic[] = ["Diplomatic relations", "Migration policy", "Security cooperation"];
export const GEOGRAPHIES: Geography[] = ["US", "Colombia"];

/** Find a source across all stories. */
export function findSource(sourceId: string): { story: Story; source: Source } | null {
  for (const story of STORIES) {
    const source = story.sources.find((s) => s.id === sourceId);
    if (source) return { story, source };
  }
  return null;
}
