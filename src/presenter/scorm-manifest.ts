/**
 * SCORM 1.2 imsmanifest.xml generator.
 * Issue #703: Generates a valid SCORM 1.2 manifest for LMS import.
 */

export interface ScormManifestOptions {
  /** Unique identifier for the package (e.g. presentation ID). */
  identifier: string;
  /** Human-readable title of the course. */
  title: string;
  /** Entry point HTML file name. */
  launchPage: string;
  /** List of resource file paths included in the package. */
  resourceFiles: string[];
}

/**
 * Generate a SCORM 1.2 compliant imsmanifest.xml string.
 * Follows ADL SCORM 1.2 Content Aggregation Model.
 */
export function generateManifest(options: ScormManifestOptions): string {
  const { identifier, title, launchPage, resourceFiles } = options;
  const safeId = escapeXml(identifier);
  const safeTitle = escapeXml(title);

  const fileEntries = resourceFiles
    .map((f) => `        <file href="${escapeXml(f)}" />`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${safeId}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
    http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">

  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>

  <organizations default="org-${safeId}">
    <organization identifier="org-${safeId}">
      <title>${safeTitle}</title>
      <item identifier="item-${safeId}" identifierref="res-${safeId}" isvisible="true">
        <title>${safeTitle}</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>

  <resources>
    <resource identifier="res-${safeId}" type="webcontent" adlcp:scormtype="sco" href="${escapeXml(launchPage)}">
      <file href="${escapeXml(launchPage)}" />
${fileEntries}
    </resource>
  </resources>

</manifest>`;
}

/** Escape XML special characters. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
