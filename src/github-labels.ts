export interface GithubLabels {
  labels: string[];
  labelColors?: Record<string, string>;
}

export function normalizeLabelColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#?([a-f\d]{6})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Keep label names compatible with filters while preserving GitHub's colour. */
export function readGithubLabels(value: unknown): GithubLabels {
  if (!Array.isArray(value)) return { labels: [] };
  const labels: string[] = [];
  const colors: Array<[string, string]> = [];
  for (const entry of value) {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const name = typeof entry === "string" ? entry : row?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    labels.push(name);
    const color = normalizeLabelColor(row?.color);
    if (color) colors.push([name, color]);
  }
  return { labels, ...(colors.length ? { labelColors: Object.fromEntries(colors) } : {}) };
}

/** The existing cache also accepts old name-only arrays. */
export function storedGithubLabels(raw: unknown): GithubLabels {
  try { return readGithubLabels(JSON.parse(String(raw))); }
  catch { return { labels: [] }; }
}

export function encodeGithubLabels({ labels, labelColors }: GithubLabels) {
  return labels.map((name) => {
    const color = normalizeLabelColor(labelColors?.[name]);
    return color ? { name, color } : name;
  });
}

function labelLuminance(rgb: readonly number[]) {
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function githubLabelStyle(value: unknown) {
  const color = normalizeLabelColor(value);
  if (!color) return undefined;
  const rgb = [0, 2, 4].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const luminance = labelLuminance(rgb);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteText = whiteContrast >= blackContrast;
  let background = rgb;
  // Preserve GitHub's border; adjust only backgrounds whose small text needs
  // more contrast. Search rounded RGB values so the rendered pair reaches 7:1.
  if (Math.max(whiteContrast, blackContrast) < 7) {
    const destination = whiteText ? 0 : 255;
    let low = 0;
    let high = 1;
    background = rgb.map(() => destination);
    for (let step = 0; step < 12; step++) {
      const amount = (low + high) / 2;
      const candidate = rgb.map((channel) => Math.round(channel + (destination - channel) * amount));
      const candidateLuminance = labelLuminance(candidate);
      const contrast = whiteText ? 1.05 / (candidateLuminance + 0.05) : (candidateLuminance + 0.05) / 0.05;
      if (contrast >= 7) {
        background = candidate;
        high = amount;
      } else {
        low = amount;
      }
    }
  }
  return {
    backgroundColor: `#${background.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
    borderColor: `#${color}`,
    color: whiteText ? "#ffffff" : "#000000",
  };
}
