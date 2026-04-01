/**
 * rxresume.mjs — Reactive Resume API client
 * Docs: https://docs.rxresu.me/api-reference
 *
 * Resume IDs (from account):
 *   security: 019d0cc9-823e-749b-80e4-77a65e25c60e  (KofiAsirifi_EndpointSecurityEngineer_2026)
 *   pm:       019d0cc4-9ee0-758d-8559-9419f49473b2  (KofiAsirifi_ProductManager_2026)
 */

const RXRESUME_BASE = 'https://rxresu.me/api/openapi';

export const RESUME_IDS = {
  security: '019d0cc9-823e-749b-80e4-77a65e25c60e',
  pm:       '019d0cc4-9ee0-758d-8559-9419f49473b2',
};

/**
 * updateResume(resumeId, data, apiKey) → updated resume object
 *
 * Patches the resume data field on rx.resume.
 * Uses PATCH /resumes/{id} with the full data payload.
 */
export async function updateResume(resumeId, data, apiKey) {
  const res = await fetch(`${RXRESUME_BASE}/resumes/${resumeId}`, {
    method: 'PATCH',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operations: [{ op: 'replace', path: '/summary/content', value: data?.sections?.summary?.content || data?.summary?.content || '' }] }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rx.resume PATCH failed: ${res.status} — ${text}`);
  }

  return res.json();
}

/**
 * getResume(resumeId, apiKey) → full resume object (includes .data)
 */
export async function getResume(resumeId, apiKey) {
  const res = await fetch(`${RXRESUME_BASE}/resumes/${resumeId}`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) throw new Error(`rx.resume GET failed: ${res.status}`);
  return res.json();
}

/**
 * exportPDF(resumeId, apiKey) → PDF download URL string
 *
 * Triggers server-side PDF generation and returns the download URL.
 */
export async function exportPDF(resumeId, apiKey) {
  const res = await fetch(`${RXRESUME_BASE}/resumes/${resumeId}/pdf`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rx.resume PDF export failed: ${res.status} — ${text}`);
  }

  // Response is a URL string pointing to the generated PDF
  const body = await res.json().catch(() => null);

  if (typeof body === 'string') return body;
  if (body?.url) return body.url;

  // Some versions return a raw text URL
  const text = await res.text().catch(() => '');
  return text.trim();
}

/**
 * createDraft(baseResumeId, name, data, apiKey) → new resume object
 *
 * Creates a new resume (draft) with tailored data.
 * Use this to avoid clobbering the base resume.
 */
export async function createDraft(baseResumeId, name, data, apiKey) {
  // First, get the base resume to copy its structure
  const base = await getResume(baseResumeId, apiKey);

  const res = await fetch(`${RXRESUME_BASE}/resumes`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50),
      data: { ...base.data, ...data },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rx.resume create draft failed: ${res.status} — ${text}`);
  }

  return res.json();
}

/**
 * deleteResume(resumeId, apiKey)
 *
 * Permanently deletes a resume. Use for cleanup of drafts.
 */
export async function deleteResume(resumeId, apiKey) {
  const res = await fetch(`${RXRESUME_BASE}/resumes/${resumeId}`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`rx.resume DELETE failed: ${res.status}`);
  }
}
