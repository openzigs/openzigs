/**
 * NLE Export — FCP XML and EDL timeline export from Director manifests.
 * Issue #826: Premiere Pro / DaVinci Resolve XML Timeline Export.
 */

export interface NLEClip {
  id: string;
  name: string;
  sourcePath: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  trackIndex: number;
  type: "video" | "audio" | "caption";
}

export interface NLETransition {
  type: "dissolve" | "cut";
  durationFrames: number;
  clipBeforeId: string;
  clipAfterId: string;
}

export interface NLETimeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: NLEClip[];
  transitions: NLETransition[];
}

export interface ManifestScene {
  id?: string;
  scriptText?: string;
  duration?: number;
  durationInFrames?: number;
  media?: { src?: string; source?: string };
  audioSrc?: string;
  transition?: { type?: string; durationInFrames?: number };
  [key: string]: unknown;
}

export interface DirectorManifestForExport {
  composition?: { fps?: number; width?: number; height?: number };
  timeline?: ManifestScene[];
  title?: string;
}

/**
 * Convert a Director manifest to an NLE timeline data structure.
 */
export function manifestToTimeline(
  manifest: DirectorManifestForExport,
  manifestTitle?: string,
): NLETimeline {
  const fps = manifest.composition?.fps ?? 30;
  const width = manifest.composition?.width ?? 1920;
  const height = manifest.composition?.height ?? 1080;
  const name = manifestTitle ?? manifest.title ?? "OpenZigs Export";

  const clips: NLEClip[] = [];
  const transitions: NLETransition[] = [];
  let currentFrame = 0;

  for (const scene of manifest.timeline ?? []) {
    const durationFrames =
      scene.durationInFrames ??
      (scene.duration ? Math.round(scene.duration * fps) : fps * 5);

    const sourcePath =
      scene.media?.src ?? scene.media?.source ?? "placeholder.mp4";
    const clipId = scene.id ?? `clip-${clips.length}`;

    // Video clip
    clips.push({
      id: clipId,
      name: scene.scriptText?.slice(0, 30) ?? `Scene ${clips.length + 1}`,
      sourcePath,
      startFrame: currentFrame,
      endFrame: currentFrame + durationFrames,
      durationFrames,
      trackIndex: 0,
      type: "video",
    });

    // Audio clip (if separate audio source)
    if (scene.audioSrc) {
      clips.push({
        id: `${clipId}-audio`,
        name: `Audio ${clips.length}`,
        sourcePath: scene.audioSrc,
        startFrame: currentFrame,
        endFrame: currentFrame + durationFrames,
        durationFrames,
        trackIndex: 1,
        type: "audio",
      });
    }

    // Caption clip
    if (scene.scriptText) {
      clips.push({
        id: `${clipId}-caption`,
        name: scene.scriptText.slice(0, 30),
        sourcePath: "",
        startFrame: currentFrame,
        endFrame: currentFrame + durationFrames,
        durationFrames,
        trackIndex: 2,
        type: "caption",
      });
    }

    // Transition
    if (scene.transition?.type && clips.length >= 2) {
      const transitionDuration = scene.transition.durationInFrames ?? 15;
      transitions.push({
        type: scene.transition.type === "dissolve" ? "dissolve" : "cut",
        durationFrames: transitionDuration,
        clipBeforeId: clips[clips.length - 2]?.id ?? clipId,
        clipAfterId: clipId,
      });
    }

    currentFrame += durationFrames;
  }

  return { name, fps, width, height, clips, transitions };
}

/**
 * Export NLE timeline to FCP XML format.
 */
export function exportFCPXML(timeline: NLETimeline): string {
  const escapeXml = (str: string) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const videoClips = timeline.clips.filter((c) => c.type === "video");
  const audioClips = timeline.clips.filter((c) => c.type === "audio");
  const captionClips = timeline.clips.filter((c) => c.type === "caption");

  // Build media references
  const mediaSources = new Set(
    timeline.clips.filter((c) => c.sourcePath).map((c) => c.sourcePath),
  );

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<!DOCTYPE xmeml>\n`;
  xml += `<xmeml version="5">\n`;
  xml += `  <project>\n`;
  xml += `    <name>${escapeXml(timeline.name)}</name>\n`;
  xml += `    <children>\n`;

  // Bins for media
  xml += `      <bin>\n`;
  xml += `        <name>Media</name>\n`;
  xml += `        <children>\n`;
  for (const src of mediaSources) {
    if (!src) continue;
    xml += `          <clip id="${escapeXml(src)}">\n`;
    xml += `            <name>${escapeXml(src)}</name>\n`;
    xml += `            <file id="file-${escapeXml(src)}">\n`;
    xml += `              <name>${escapeXml(src)}</name>\n`;
    xml += `              <pathurl>file://localhost/${escapeXml(src)}</pathurl>\n`;
    xml += `              <rate><timebase>${timeline.fps}</timebase><ntsc>FALSE</ntsc></rate>\n`;
    xml += `            </file>\n`;
    xml += `          </clip>\n`;
  }
  xml += `        </children>\n`;
  xml += `      </bin>\n`;

  // Sequence
  xml += `      <sequence>\n`;
  xml += `        <name>${escapeXml(timeline.name)}</name>\n`;
  xml += `        <rate><timebase>${timeline.fps}</timebase><ntsc>FALSE</ntsc></rate>\n`;
  xml += `        <media>\n`;

  // Video track
  xml += `          <video>\n`;
  xml += `            <format>\n`;
  xml += `              <samplecharacteristics>\n`;
  xml += `                <width>${timeline.width}</width>\n`;
  xml += `                <height>${timeline.height}</height>\n`;
  xml += `              </samplecharacteristics>\n`;
  xml += `            </format>\n`;
  xml += `            <track>\n`;
  for (const clip of videoClips) {
    xml += `              <clipitem id="${escapeXml(clip.id)}">\n`;
    xml += `                <name>${escapeXml(clip.name)}</name>\n`;
    xml += `                <start>${clip.startFrame}</start>\n`;
    xml += `                <end>${clip.endFrame}</end>\n`;
    xml += `                <in>0</in>\n`;
    xml += `                <out>${clip.durationFrames}</out>\n`;
    xml += `                <file id="file-${escapeXml(clip.sourcePath)}"/>\n`;
    xml += `              </clipitem>\n`;
  }
  xml += `            </track>\n`;

  // Caption track
  if (captionClips.length > 0) {
    xml += `            <track>\n`;
    for (const clip of captionClips) {
      xml += `              <clipitem id="${escapeXml(clip.id)}">\n`;
      xml += `                <name>${escapeXml(clip.name)}</name>\n`;
      xml += `                <start>${clip.startFrame}</start>\n`;
      xml += `                <end>${clip.endFrame}</end>\n`;
      xml += `              </clipitem>\n`;
    }
    xml += `            </track>\n`;
  }

  xml += `          </video>\n`;

  // Audio track
  if (audioClips.length > 0) {
    xml += `          <audio>\n`;
    xml += `            <track>\n`;
    for (const clip of audioClips) {
      xml += `              <clipitem id="${escapeXml(clip.id)}">\n`;
      xml += `                <name>${escapeXml(clip.name)}</name>\n`;
      xml += `                <start>${clip.startFrame}</start>\n`;
      xml += `                <end>${clip.endFrame}</end>\n`;
      xml += `                <in>0</in>\n`;
      xml += `                <out>${clip.durationFrames}</out>\n`;
      xml += `                <file id="file-${escapeXml(clip.sourcePath)}"/>\n`;
      xml += `              </clipitem>\n`;
    }
    xml += `            </track>\n`;
    xml += `          </audio>\n`;
  }

  xml += `        </media>\n`;
  xml += `      </sequence>\n`;
  xml += `    </children>\n`;
  xml += `  </project>\n`;
  xml += `</xmeml>\n`;

  return xml;
}

/**
 * Export NLE timeline to CMX3600 EDL format.
 */
export function exportEDL(timeline: NLETimeline): string {
  const videoClips = timeline.clips.filter((c) => c.type === "video");

  const formatTC = (frame: number): string => {
    const totalSeconds = frame / timeline.fps;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const frames = Math.floor(frame % timeline.fps);
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
  };

  let edl = `TITLE: ${timeline.name}\n`;
  edl += `FCM: NON-DROP FRAME\n\n`;

  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    const editNumber = String(i + 1).padStart(3, "0");
    const srcIn = "00:00:00:00";
    const srcOut = formatTC(clip.durationFrames);
    const recIn = formatTC(clip.startFrame);
    const recOut = formatTC(clip.endFrame);

    // Determine transition type
    const transition = timeline.transitions.find(
      (t) => t.clipAfterId === clip.id,
    );
    const transType = transition?.type === "dissolve" ? "D" : "C";
    const transDuration =
      transition?.type === "dissolve"
        ? ` ${String(transition.durationFrames).padStart(3, "0")}`
        : "";

    edl += `${editNumber}  AX       V     ${transType}${transDuration}    ${srcIn} ${srcOut} ${recIn} ${recOut}\n`;
    edl += `* FROM CLIP NAME: ${clip.sourcePath}\n`;
    if (clip.name) {
      edl += `* COMMENT: ${clip.name}\n`;
    }
    edl += `\n`;
  }

  return edl;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
