// Reads output.json and auto-creates sv_chapters + sv_vocab entries in cards.db
// by matching English glosses against keyword buckets.
//
// Usage:  bun seed_chapters.ts [--dry-run] [--chapter-size N] [--list-misc]
// Options:
//   --dry-run        Print what would be created without touching the database.
//   --chapter-size N Split each topic into sub-chapters of at most N words (default: 50).
//   --list-misc      Print all glosses that fall into the Miscellaneous bucket, then exit.

import { Database } from "bun:sqlite";
import outputData from "./output.json";

const args = Bun.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIST_MISC = args.includes("--list-misc");
const CHAPTER_SIZE = (() => {
  const idx = args.indexOf("--chapter-size");
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 50;
})();

const db = new Database(Bun.env.CARDS_DB_PATH ?? "cards.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ── Topic definitions ─────────────────────────────────────────────────
// Order matters — first matching topic wins.
// Each keyword is matched as a whole word (word-boundary regex).
// Phrases with spaces use substring matching.

const TOPICS: { title: string; keywords: string[] }[] = [
  {
    title: "Greetings & Basics",
    keywords: [
      "yes", "no", "ok", "okay", "hi", "hello", "bye", "goodbye", "thank", "please",
      "sorry", "excuse", "welcome", "nice to meet", "good morning", "good evening",
      "good night", "see you", "cheers", "congratulations", "good luck",
    ],
  },
  {
    title: "Numbers & Counting",
    keywords: [
      "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
      "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
      "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
      "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million",
      "billion", "count", "number", "first", "second", "third", "fourth",
    ],
  },
  {
    title: "Food & Cooking",
    keywords: [
      "eat", "cook", "food", "meal", "breakfast", "lunch", "dinner", "rice", "bread",
      "meat", "fish", "egg", "soup", "salad", "fruit", "fruits", "vegetable", "cheese",
      "sugar", "salt", "pepper", "spice", "noodle", "ramen", "sushi", "mushroom",
      "lemon", "orange", "apple", "banana", "strawberry", "cherry", "mango",
      "fork", "spoon", "knife", "plate", "bowl", "chopstick", "recipe",
      "delicious", "hungry", "taste", "flavor", "menu", "portion", "diet",
      "bake", "fry", "boil", "grill", "roast", "stir", "chop", "slice",
      "ingredient", "sauce", "dressing", "seasoning", "tofu", "miso",
    ],
  },
  {
    title: "Drinks",
    keywords: [
      "drink", "water", "tea", "coffee", "milk", "juice", "soda", "coke", "cola",
      "beer", "wine", "sake", "alcohol", "cocktail", "smoothie", "lemonade",
      "thirst", "cup", "glass", "bottle", "mug", "can", "straw", "espresso",
      "mineral water", "orange juice", "hot chocolate", "chai",
    ],
  },
  {
    title: "People & Family",
    keywords: [
      "woman", "man", "girl", "boy", "person", "people", "child", "children",
      "baby", "mom", "dad", "mother", "father", "brother", "sister", "sibling",
      "parent", "family", "husband", "wife", "partner", "friend", "neighbor",
      "relative", "grandma", "grandpa", "grandson", "granddaughter", "aunt",
      "uncle", "cousin", "twin", "couple", "widow", "widower",
    ],
  },
  {
    title: "Body & Health",
    keywords: [
      "body", "head", "face", "eye", "ear", "nose", "mouth", "hand", "foot", "feet",
      "arm", "leg", "finger", "thumb", "toe", "tooth", "teeth", "hair", "skin",
      "neck", "shoulder", "chest", "back", "knee", "elbow", "wrist", "ankle",
      "heart", "lung", "liver", "stomach", "brain", "muscle", "bone", "blood",
      "health", "sick", "illness", "disease", "pain", "hurt", "ache", "injury",
      "doctor", "nurse", "hospital", "clinic", "medicine", "drug", "pill",
      "fever", "cold", "cough", "headache", "diabetes", "allergy", "surgery",
      "appointment", "pharmacy", "prescription", "symptom", "diagnosis",
    ],
  },
  {
    title: "Clothing & Appearance",
    keywords: [
      "wear", "clothes", "clothing", "dress", "shirt", "pants", "trousers", "skirt",
      "shoes", "boot", "sneaker", "hat", "cap", "coat", "jacket", "sweater",
      "hoodie", "scarf", "glove", "sock", "underwear", "swimsuit", "uniform",
      "bag", "purse", "glasses", "sunglasses", "watch", "jewelry", "ring",
      "necklace", "fashion", "outfit", "style", "makeup", "nail", "manicure",
      "lipstick", "perfume", "beautiful", "pretty", "handsome", "cute", "ugly",
      "elegant", "casual", "formal", "size", "fit", "tight", "loose",
    ],
  },
  {
    title: "Hotel & Accommodation",
    keywords: [
      "hotel", "hostel", "motel", "inn", "resort", "housekeeper", "bellboy",
      "receptionist", "reception", "guest", "check-in", "check-out",
      "key card", "room service", "the safe", "safe", "air conditioner",
      "elevator", "lobby", "concierge", "booking", "reservation",
    ],
  },
  {
    title: "Home & Daily Life",
    keywords: [
      "home", "house", "apartment", "flat", "room", "kitchen", "bathroom",
      "shower", "toilet", "bath", "bathtub", "bed", "bedroom", "living room",
      "dining room", "garage", "basement", "attic", "garden", "yard", "balcony",
      "door", "window", "wall", "ceiling", "floor", "stair", "roof",
      "table", "chair", "sofa", "couch", "desk", "shelf", "drawer",
      "furniture", "lamp", "curtain", "carpet", "rug", "mirror", "clock",
      "clean", "wash", "laundry", "sweep", "vacuum", "iron", "cook", "wake", "sleep",
    ],
  },
  {
    title: "Time & Calendar",
    keywords: [
      "time", "hour", "minute", "second", "day", "week", "month", "year",
      "today", "yesterday", "tomorrow", "morning", "noon", "afternoon",
      "evening", "night", "midnight", "dawn", "dusk", "now", "soon",
      "early", "late", "spring", "summer", "autumn", "fall", "winter",
      "season", "date", "calendar", "schedule", "birthday", "anniversary",
      "holiday", "weekend", "weekday", "monday", "tuesday", "wednesday",
      "thursday", "friday", "saturday", "sunday", "january", "february",
      "march", "april", "may", "june", "july", "august", "september",
      "october", "november", "december",
    ],
  },
  {
    title: "Travel & Airport",
    keywords: [
      "travel", "trip", "journey", "tour", "airport", "terminal", "gate",
      "airplane", "aircraft", "flight", "airline", "pilot", "stewardess",
      "passenger", "boarding", "departure", "arrival", "take off", "land",
      "ticket", "flight ticket", "passport", "passport control", "visa",
      "customs", "immigration", "baggage", "luggage", "suitcase", "luggage cart",
      "baggage claim", "excess baggage", "check-in", "destination",
      "tourist", "sightseeing", "vacation", "holiday", "itinerary", "scale",
    ],
  },
  {
    title: "Transportation",
    keywords: [
      "train", "bus", "car", "bike", "bicycle", "taxi", "cab", "truck", "van",
      "subway", "metro", "underground", "tram", "trolleybus", "moped",
      "motorcycle", "scooter", "boat", "ship", "ferry", "helicopter",
      "airship", "cable car", "ride", "drive", "cycle", "station", "stop",
      "route", "traffic", "road", "highway", "motorway", "fuel", "gas",
      "parking", "seat", "driver", "passenger", "timetable", "platform",
    ],
  },
  {
    title: "Places & Directions",
    keywords: [
      "place", "location", "here", "there", "where", "left", "right", "straight",
      "north", "south", "east", "west", "near", "far", "inside", "outside",
      "above", "below", "corner", "intersection", "crossroad", "crosswalk",
      "bridge", "tunnel", "square", "plaza", "fountain", "monument",
      "school", "university", "college", "hospital", "clinic", "pharmacy",
      "store", "shop", "mall", "market", "supermarket", "library", "museum",
      "gallery", "theater", "cinema", "restaurant", "cafe", "bar", "pub",
      "park", "garden", "zoo", "beach", "pool", "stadium", "gym",
      "city", "town", "village", "country", "region", "district",
      "office", "bank", "ATM", "post", "embassy", "police",
      "church", "cathedral", "temple", "mosque", "cemetery", "castle",
      "street", "avenue", "boulevard", "alley", "disco",
    ],
  },
  {
    title: "Nature & Animals",
    keywords: [
      "nature", "environment", "animal", "wildlife", "pet",
      "dog", "cat", "bird", "horse", "cow", "pig", "chicken", "duck",
      "rabbit", "mouse", "rat", "lion", "tiger", "bear", "elephant",
      "giraffe", "monkey", "fox", "wolf", "deer", "sheep", "goat",
      "snake", "lizard", "frog", "fish", "whale", "dolphin", "shark",
      "ant", "bee", "butterfly", "spider", "insect", "bug",
      "tree", "flower", "grass", "bush", "leaf", "branch", "root",
      "forest", "jungle", "mountain", "hill", "valley", "cave",
      "river", "lake", "pond", "waterfall", "stream",
      "sea", "ocean", "beach", "island", "desert", "plain",
      "sky", "cloud", "rain", "snow", "sun", "moon", "star",
      "wind", "storm", "rainbow", "earth", "plant", "seed",
      "palm tree", "lollipop tree",
    ],
  },
  {
    title: "Weather",
    keywords: [
      "weather", "forecast", "temperature", "degree",
      "sunny", "cloudy", "overcast", "rainy", "snowy", "windy", "foggy",
      "humid", "dry", "hot", "warm", "cool", "cold", "freezing",
      "thunder", "lightning", "hail", "flood", "drought", "earthquake",
      "volcano", "tsunami", "hurricane", "tornado", "blizzard",
    ],
  },
  {
    title: "Colors & Descriptions",
    keywords: [
      "color", "colour", "red", "blue", "green", "yellow", "black", "white",
      "pink", "purple", "violet", "orange", "brown", "gray", "grey",
      "gold", "silver", "bright", "dark", "light", "pale", "vivid",
      "big", "small", "large", "huge", "tiny", "medium",
      "tall", "short", "long", "wide", "narrow", "thick", "thin",
      "heavy", "light", "fast", "quick", "slow", "new", "old", "young",
      "round", "square", "triangle", "oval", "flat", "sharp", "smooth",
      "rough", "soft", "hard", "clean", "dirty", "wet", "dry",
      "full", "empty", "open", "closed", "right", "wrong",
      "easy", "difficult", "simple", "complex",
    ],
  },
  {
    title: "Emotions & Feelings",
    keywords: [
      "happy", "sad", "angry", "upset", "frustrated", "excited", "nervous",
      "anxious", "scared", "afraid", "frightened", "surprised", "shocked",
      "bored", "fun", "joy", "love", "hate", "like", "dislike", "enjoy",
      "feel", "feeling", "mood", "emotion", "worry", "hope", "wish",
      "dream", "lonely", "tired", "exhausted", "stressed", "relax",
      "laugh", "cry", "smile", "frown", "miss", "proud", "ashamed",
      "embarrassed", "jealous", "grateful", "disappointed",
    ],
  },
  {
    title: "School & Study",
    keywords: [
      "study", "learn", "school", "kindergarten", "class", "classroom", "lesson",
      "homework", "assignment", "exam", "test", "quiz", "grade", "mark",
      "book", "textbook", "notebook", "pen", "pencil", "eraser", "ruler",
      "write", "read", "draw", "teach", "explain", "practice",
      "subject", "english", "japanese", "chinese", "korean", "french",
      "math", "science", "biology", "chemistry", "physics", "history",
      "geography", "literature", "art", "music class",
      "language", "grammar", "vocabulary", "pronunciation",
      "student", "pupil", "teacher", "professor", "principal",
      "university", "college", "graduate", "degree", "diploma",
      "scholarship", "tuition", "campus", "library", "cafeteria",
    ],
  },
  {
    title: "Work & Business",
    keywords: [
      "work", "job", "career", "profession", "occupation",
      "company", "firm", "corporation", "organization",
      "office", "workplace", "factory", "farm",
      "business", "meeting", "conference", "presentation", "project",
      "boss", "manager", "director", "CEO", "employee", "staff",
      "salary", "wage", "income", "bonus", "promotion",
      "colleague", "coworker", "team", "department",
      "interview", "hire", "fired", "resign", "retire",
      "deadline", "overtime", "schedule", "contract",
      "scientist", "engineer", "lawyer", "accountant",
    ],
  },
  {
    title: "Money & Shopping",
    keywords: [
      "money", "cash", "coin", "bill", "currency", "dollar", "euro", "yen",
      "pound", "franc", "yuan", "price", "cost", "fee", "charge", "rent",
      "buy", "purchase", "sell", "pay", "spend", "save", "afford", "budget",
      "expensive", "cheap", "free", "discount", "sale", "offer", "deal",
      "receipt", "invoice", "tax", "tip", "change", "refund",
      "wallet", "purse", "credit card", "debit card", "ATM", "bank account",
      "coupon", "customer", "cashier", "shopping basket", "shopping cart",
      "checkout", "queue", "gift", "wrap",
    ],
  },
  {
    title: "Sports & Exercise",
    keywords: [
      "sport", "exercise", "fitness", "training", "workout",
      "run", "jog", "sprint", "swim", "cycle", "hike", "climb",
      "play", "game", "match", "tournament", "competition", "championship",
      "soccer", "football", "basketball", "baseball", "volleyball",
      "tennis", "badminton", "golf", "rugby", "cricket", "hockey",
      "boxing", "wrestling", "martial arts", "yoga", "pilates",
      "gym", "court", "field", "track", "pool",
      "team", "player", "coach", "referee", "athlete",
      "win", "lose", "draw", "score", "goal", "point",
      "dance", "jump", "kick", "throw", "catch", "hit", "push",
    ],
  },
  {
    title: "Technology & Media",
    keywords: [
      "phone", "mobile", "smartphone", "tablet", "laptop", "computer", "PC",
      "internet", "wifi", "wireless", "bluetooth", "network",
      "email", "message", "text", "chat", "call", "video call",
      "app", "software", "program", "website", "browser", "search",
      "social media", "instagram", "twitter", "facebook",
      "photo", "picture", "image", "video", "stream", "download", "upload",
      "music", "podcast", "television", "TV", "radio", "news",
      "screen", "monitor", "keyboard", "mouse", "printer", "camera",
      "password", "username", "account", "profile", "notification",
      "battery", "charger", "cable", "USB", "lock screen", "ebook",
    ],
  },
  {
    title: "Art & Culture",
    keywords: [
      "art", "artist", "painting", "drawing", "sketch", "sculpture", "gallery",
      "movie", "film", "cinema", "actor", "actress", "director",
      "music", "song", "singer", "band", "concert", "album",
      "book", "novel", "poem", "story", "author", "literature",
      "theater", "play", "performance", "show", "stage",
      "dance", "ballet", "opera", "orchestra",
      "culture", "tradition", "heritage", "history",
      "festival", "celebration", "ceremony", "ritual",
      "museum", "exhibition", "craft", "design", "architecture",
    ],
  },
  {
    title: "Actions & Verbs",
    keywords: [
      "go", "come", "arrive", "leave", "enter", "exit", "return",
      "walk", "run", "jump", "climb", "fall", "sit", "stand", "lie",
      "give", "take", "bring", "carry", "hold", "lift", "put", "drop",
      "open", "close", "push", "pull", "turn", "move",
      "see", "look", "watch", "hear", "listen", "smell", "touch",
      "say", "tell", "speak", "talk", "ask", "answer", "call", "shout",
      "think", "know", "understand", "remember", "forget", "learn",
      "read", "write", "count", "calculate",
      "want", "need", "like", "love", "prefer", "choose",
      "make", "create", "build", "break", "fix", "use",
      "start", "begin", "stop", "finish", "continue",
      "help", "try", "succeed", "fail", "meet", "wait", "follow",
      "find", "lose", "search", "show", "hide", "change",
      "buy", "sell", "pay", "get", "send", "receive",
      "eat", "drink", "sleep", "wake", "rest", "play",
      "pose",
    ],
  },
];

const MISC_TITLE = "General Vocabulary";

// ── Matching logic ────────────────────────────────────────────────────

function buildWordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Use word boundaries for single words; substring match for phrases
  return keyword.includes(" ")
    ? new RegExp(escaped, "i")
    : new RegExp(`\\b${escaped}\\b`, "i");
}

const compiled = TOPICS.map((t) => ({
  ...t,
  regexes: t.keywords.map(buildWordRegex),
}));

function classifyGloss(gloss: string): string {
  for (const topic of compiled) {
    if (topic.regexes.some((re) => re.test(gloss))) return topic.title;
  }
  return MISC_TITLE;
}

// ── Bucket words ──────────────────────────────────────────────────────

type Word = { outputId: string; kanji: string; reading: string; gloss: string };
const buckets = new Map<string, Word[]>();
for (const t of TOPICS) buckets.set(t.title, []);
buckets.set(MISC_TITLE, []);

for (const [id, entry] of Object.entries(outputData as Record<string, { p: string; ro: string; alt: string; en: string; sound?: string }>)) {
  if (!entry.p) continue;
  const gloss = entry.en ?? "";
  const topic = classifyGloss(gloss);
  buckets.get(topic)!.push({
    outputId: id,
    kanji: entry.alt ?? entry.p,
    reading: entry.p,
    gloss,
  });
}

// ── Report ────────────────────────────────────────────────────────────

const allTopics = [...TOPICS.map((t) => t.title), MISC_TITLE];
const total = [...buckets.values()].reduce((s, b) => s + b.length, 0);

console.log(`\nTotal words: ${total}\n`);
for (const title of allTopics) {
  const words = buckets.get(title)!;
  if (words.length === 0) continue;
  const chapters = Math.ceil(words.length / CHAPTER_SIZE);
  console.log(`  ${title.padEnd(32)} ${String(words.length).padStart(4)} word(s) → ${chapters} chapter(s)`);
}
console.log();

if (LIST_MISC) {
  const misc = buckets.get(MISC_TITLE)!;
  console.log(`Miscellaneous (${misc.length} words):\n`);
  for (const w of misc) console.log(`  [${w.outputId}] ${w.kanji}  (${w.gloss})`);
  process.exit(0);
}

if (DRY_RUN) {
  console.log("--dry-run: no changes written.");
  process.exit(0);
}

// ── Write to database ─────────────────────────────────────────────────

const existingTitles = new Set(
  db.query<{ title: string }, []>("SELECT title FROM sv_chapters").all().map((r) => r.title),
);

const insertChapter = db.prepare<{ id: string }, [string, string, string, number]>(
  "INSERT INTO sv_chapters (id, title, subtitle, created_at) VALUES (?, ?, ?, ?) RETURNING id",
);

const insertVocab = db.prepare(
  `INSERT INTO sv_vocab (chapter_id, output_id, kanji, reading, gloss, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

let chaptersCreated = 0;
let wordsInserted = 0;

const insertAll = db.transaction(() => {
  const now = Date.now();

  for (const topicTitle of allTopics) {
    const words = buckets.get(topicTitle)!;
    if (words.length === 0) continue;

    const totalChapters = Math.ceil(words.length / CHAPTER_SIZE);

    for (let ci = 0; ci < totalChapters; ci++) {
      const slice = words.slice(ci * CHAPTER_SIZE, (ci + 1) * CHAPTER_SIZE);
      const chapterTitle =
        totalChapters === 1 ? topicTitle : `${topicTitle} (${ci + 1}/${totalChapters})`;

      if (existingTitles.has(chapterTitle)) {
        console.log(`  SKIP  ${chapterTitle}`);
        continue;
      }

      const id = `c-${now + ci}-${Math.random().toString(36).slice(2, 7)}`;
      insertChapter.get(id, chapterTitle, topicTitle === MISC_TITLE ? "" : topicTitle, now + ci);
      chaptersCreated++;

      for (const w of slice) {
        insertVocab.run(id, w.outputId, w.kanji, w.reading, w.gloss, now);
        wordsInserted++;
      }

      console.log(`  CREATE ${chapterTitle.padEnd(45)} (${slice.length} words)`);
    }
  }
});

insertAll();

console.log(`\nDone. Created ${chaptersCreated} chapter(s), inserted ${wordsInserted} word(s).`);
