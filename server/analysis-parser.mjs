import { plantReference } from "./plant-reference.mjs";

export function parseModelResult(content) {
  const normalizedContent = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return normalizeModelResult(JSON.parse(normalizedContent));
  } catch {
    const firstBrace = normalizedContent.indexOf("{");
    const lastBrace = normalizedContent.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return normalizeModelResult(JSON.parse(normalizedContent.slice(firstBrace, lastBrace + 1)));
      } catch {
        // Continue with the plain-text formats used by some NVIDIA model responses.
      }
    }
  }

  return parseHeadedText(normalizedContent);
}

function normalizeModelResult(parsed) {
  if (
    !parsed ||
    typeof parsed.plant !== "string" ||
    typeof parsed.scientificName !== "string" ||
    typeof parsed.condition !== "string" ||
    typeof parsed.description !== "string" ||
    (typeof parsed.confidence !== "number" && parsed.confidence !== null) ||
    !Array.isArray(parsed.steps) ||
    !parsed.steps.every((step) => typeof step === "string")
  ) {
    return null;
  }

  const scientificName = cleanModelText(parsed.scientificName).slice(0, 120);
  const plantIdentity = normalizePlantIdentity(parsed.plant, scientificName);
  return {
    plant: plantIdentity.conflicts ? "Bitki türü belirlenemedi" : normalizePlantName(parsed.plant).slice(0, 120),
    scientificName: plantIdentity.conflicts ? "Belirlenemedi" : scientificName,
    condition: ensureTurkish(cleanModelText(parsed.condition), "Belirti belirlenemedi").slice(0, 160),
    confidence: !plantIdentity.conflicts && typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : null,
    description: plantIdentity.conflicts
      ? "Modelin verdiği bitki adı ile bilimsel adı birbiriyle uyuşmadığı için bitki türü belirlenemedi. Daha net, yaprağın tamamını ve gövdeye bağlandığı yeri gösteren bir fotoğraf deneyin."
      : ensureTurkish(
      cleanModelText(parsed.description),
      "Yaprak özellikleri görselden tahmin edilmiştir; bu sonuç uzman değerlendirmesiyle doğrulanmalıdır.",
    ).slice(0, 600),
    alternatives: plantIdentity.conflicts ? [] : normalizeAlternatives(parsed.alternatives),
    steps: safeSteps(parsed.steps.filter((step) => !containsEnglishExplanation(step))),
  };
}

function normalizePlantIdentity(plantName, scientificName) {
  const normalizedPlantName = normalizePlantReferenceName(cleanModelText(plantName));
  const candidates = plantReference.filter(([turkish, english]) =>
    normalizedPlantName === normalizePlantReferenceName(turkish) ||
    normalizedPlantName === normalizePlantReferenceName(english) ||
    normalizedPlantName === normalizePlantReferenceName(`${turkish} (${english})`),
  );
  const scientificSpecies = getCataloguedScientificSpecies(scientificName);
  if (candidates.length === 0 || !scientificSpecies) return { conflicts: false };
  return {
    conflicts: !candidates.some(([, , scientific]) =>
      getScientificSpeciesName(scientific) === scientificSpecies,
    ),
  };
}

function getCataloguedScientificSpecies(value) {
  const normalized = getScientificSpeciesName(value);
  if (normalized.split(" ").length !== 2) return "";
  return plantReference.some(([, , scientific]) => getScientificSpeciesName(scientific) === normalized)
    ? normalized
    : "";
}

function getScientificSpeciesName(value) {
  return cleanModelText(value)
    .replace(/\s+(?:subsp\.?|ssp\.?|var\.?|f\.?)\s+.+$/i, "")
    .toLocaleLowerCase("en")
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

function parseHeadedText(content) {
  const labelled = parseLabelledText(content);
  if (labelled) return labelled;

  const sections = new Map();
  let currentHeading = "";
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      currentHeading = normalizeHeading(heading[1]);
      sections.set(currentHeading, []);
    } else if (currentHeading && line.trim()) {
      sections.get(currentHeading).push(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim());
    }
  }
  if (sections.size === 0) return null;

  const findSection = (pattern) => {
    for (const [heading, lines] of sections) {
      if (pattern.test(heading)) return lines.join(" ").trim();
    }
    return "";
  };
  const plantDescription = findSection(/bitki (?:tanimi|aciklamasi|ozellikleri)|plant description/);
  const plantName = findSection(/bitki (?:turu|adi|kimligi)|plant (?:type|name)/);
  const condition = findSection(/hastalik|belirti|olasi durum|condition|disease|symptom/);
  const confidenceText = findSection(/guvenilirlik|guven duzeyi|confidence/);
  const description = findSection(/^aciklama$|degerlendirme|observations|description/);
  const stepsText = findSection(/oneriler|bakim onerileri|sonraki adimlar|steps|recommendations/);
  const confidenceMatch = confidenceText.match(/\b(100|[1-9]?\d)\s*%/);
  const steps = stepsText
    .split(/\s*(?:\s{2,}|[;•])\s*/)
    .map((step) => step.trim())
    .filter(Boolean);
  const summary = [plantDescription, description].filter(Boolean).join(" ");

  return {
    plant: (plantName || "Belirlenemedi").slice(0, 120),
    scientificName: "Belirlenemedi",
    condition: (condition || "Belirti belirlenemedi").slice(0, 160),
    confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
    description: (summary || content.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim()).slice(0, 600),
    alternatives: [],
    steps: safeSteps(steps),
  };
}

function parseLabelledText(content) {
  const labels = [
    ["plant", "Türkçe adı"],
    ["plant", "Bitki adı"],
    ["plant", "Bitki türü"],
    ["plant", "Bitki kimliği"],
    ["plant", "Plant name"],
    ["plant", "Species"],
    ["scientificName", "Bilimsel adı"],
    ["scientificName", "Latince adı"],
    ["scientificName", "Scientific name"],
    ["condition", "Görünen olası belirti"],
    ["condition", "Olası belirti"],
    ["condition", "Hastalık"],
    ["condition", "Belirti"],
    ["condition", "Condition"],
    ["condition", "Disease"],
    ["confidence", "Güvenilirlik"],
    ["confidence", "Güven düzeyi"],
    ["confidence", "Confidence"],
    ["description", "Açıklama"],
    ["description", "Değerlendirme"],
    ["description", "Observations"],
    ["steps", "Güvenli adımlar"],
    ["steps", "Öneriler"],
    ["steps", "Bakım önerileri"],
    ["steps", "Recommendations"],
    ["steps", "Steps"],
    ["alternatives", "Alternatifler"],
    ["alternatives", "Diğer olasılıklar"],
    ["alternatives", "Alternatives"],
  ];
  const searchableContent = normalizeLabelSearch(content).replace(/\*/g, " ");
  const candidates = [];
  for (const [field, label] of labels) {
    const escapedLabel = normalizeLabelSearch(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escapedLabel}\\s*:`, "gi");
    let match;
    while ((match = pattern.exec(searchableContent)) !== null) {
      candidates.push({ field, start: match.index, valueStart: pattern.lastIndex });
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.valueStart - a.valueStart);
  const markers = [];
  for (const candidate of candidates) {
    const previous = markers[markers.length - 1];
    if (!previous || candidate.start >= previous.valueStart) markers.push(candidate);
  }
  if (markers.length === 0) return null;

  const fields = new Map();
  markers.forEach((marker, index) => {
    const end = markers[index + 1]?.start ?? content.length;
    fields.set(marker.field, cleanModelText(content.slice(marker.valueStart, end)));
  });
  const plant = fields.get("plant") || "";
  const scientificName = fields.get("scientificName") || "";
  const condition = fields.get("condition") || "";
  const confidenceText = fields.get("confidence") || "";
  const description = fields.get("description") || "";
  const stepsText = fields.get("steps") || "";

  const confidenceMatch = confidenceText.match(/\b(100|[1-9]?\d)(?:\s*%|\b)/);
  const steps = stepsText
    .split(/(?<=[.!?])\s+|\s*[;•]\s*/)
    .map((step) => step.replace(/^\*\*|\*\*$/g, "").trim())
    .filter(Boolean);

  return {
    plant: normalizePlantName(plant || "Belirlenemedi").slice(0, 120),
    scientificName: cleanModelText(scientificName || "Belirlenemedi").slice(0, 120),
    condition: ensureTurkish(cleanModelText(condition || "Belirti belirlenemedi"), "Belirti belirlenemedi").slice(0, 160),
    confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
    description: ensureTurkish(
      cleanModelText(description || content),
      "Yaprak özellikleri görselden tahmin edilmiştir; bu sonuç uzman değerlendirmesiyle doğrulanmalıdır.",
    ).slice(0, 600),
    alternatives: [],
    steps: safeSteps(steps.filter((step) => !containsEnglishExplanation(step))),
  };
}

function normalizePlantName(value) {
  const cleaned = cleanModelText(value);
  const mapleMatch = cleaned.match(/^(maple|akçaağaç)(?: yaprağı)?(?:\s*\(([^)]*)\))?$/i);
  if (mapleMatch) {
    const parenthetical = mapleMatch[2]?.trim();
    const isEnglishNameFirst = /^maple$/i.test(mapleMatch[1]);
    const englishName = isEnglishNameFirst
      ? "Maple"
      : parenthetical && !/^(ağaç|tree)$/i.test(parenthetical)
        ? parenthetical
        : "Maple";
    return `Akçaağaç${englishName ? ` (${englishName})` : ""}`;
  }
  const knownPlant = plantReference.find(([turkish, english]) => {
    const normalizedName = normalizePlantReferenceName(cleaned);
    return normalizedName === normalizePlantReferenceName(turkish) ||
      normalizedName === normalizePlantReferenceName(english) ||
      normalizedName === normalizePlantReferenceName(`${turkish} (${english})`);
  });
  if (knownPlant) return `${knownPlant[0]} (${knownPlant[1]})`;
  return cleaned;
}

function normalizeLabelSearch(value) {
  return value
    .replace(/İ/g, "I")
    .toLowerCase()
    .replace(/[ı]/g, "i")
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u");
}

function cleanModelText(value) {
  return value
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAlternatives(alternatives) {
  if (!Array.isArray(alternatives)) return [];
  const knownNames = new Set(
    plantReference.map(([turkish, english]) => normalizePlantReferenceName(`${turkish} (${english})`)),
  );
  const seen = new Set();
  return alternatives
    .filter((item) => item && typeof item === "object" && typeof item.name === "string" && typeof item.evidence === "string")
    .map((item) => ({
      name: normalizePlantName(item.name).slice(0, 120),
      evidence: ensureTurkish(cleanModelText(item.evidence), "").slice(0, 180),
    }))
    .filter((item) => {
      const name = normalizePlantReferenceName(item.name);
      if (!item.evidence || containsEnglishExplanation(item.evidence) || !knownNames.has(name) || seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    })
    .slice(0, 2);
}

function normalizePlantReferenceName(value) {
  return value
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsEnglishExplanation(value) {
  return /\b(?:the|this|that|image|photo|leaf|leaves|plant|which|however|visible|because|with|from|therefore|could|may indicate|brown spots|further examination|would be necessary|disease|detected|rough texture|observe|observation|carefully)\b/i.test(value);
}

function ensureTurkish(value, fallback) {
  return containsEnglishExplanation(value) ? fallback : value;
}

function safeSteps(steps) {
  const safe = steps
    .filter((step) => !/\b(pestisit|fungisit|ilaç|doz|spreyle|püskürt)\b/i.test(step))
    .slice(0, 3)
    .map((step) => step.slice(0, 240));
  return safe.length > 0
    ? safe
    : [
        "Bitkinizi düzenli gözlemleyin ve belirtilerdeki değişimi not edin.",
        "Belirtiler sürer veya artarsa yerel bir ziraat uzmanına danışın.",
      ];
}

function normalizeHeading(heading) {
  return heading
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
