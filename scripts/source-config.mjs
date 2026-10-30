const VALID_TYPES = new Set(["rss", "html", "openalex", "arbeitsagentur", "jobsacuk", "page", "discovered", "isprs-calendar", "discovered-events"]);
const VALID_KINDS = new Set(["job", "course", "event", "news", "paper", "auto"]);

export function getEnabledSources(config) {
  if (!config || !Array.isArray(config.sources)) {
    throw new Error("config/sources.json must contain a sources array");
  }

  const enabled = config.sources.filter((source) => source?.enabled === true);
  if (enabled.length === 0) {
    throw new Error("No enabled sources configured; refusing to publish a feed from zero sources");
  }

  const seenIds = new Set();
  for (const source of enabled) {
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!id) throw new Error("An enabled source is missing its stable id");
    if (seenIds.has(id)) throw new Error(`Duplicate enabled source id: ${id}`);
    seenIds.add(id);

    if (typeof source.name !== "string" || !source.name.trim()) {
      throw new Error(`Enabled source ${id} is missing a name`);
    }

    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error(`Enabled source ${id} has an invalid URL`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`Enabled source ${id} must use HTTPS`);
    }
    if (!VALID_TYPES.has(source.type)) {
      throw new Error(`Enabled source ${id} has unsupported type: ${source.type}`);
    }
    if (source.kind != null && !VALID_KINDS.has(source.kind)) {
      throw new Error(`Enabled source ${id} has unsupported kind: ${source.kind}`);
    }
  }

  return enabled;
}
