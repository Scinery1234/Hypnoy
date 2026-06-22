/**
 * Generate a structured, timed hypnosis script.
 * Calls the serverless endpoint at /api/hypnosis.
 *
 * @param {{ prompt: string, durationMinutes?: number, tone?: string }} params
 * @returns {Promise<{ script: object }>}
 */
export async function generateHypnosisScript({ prompt, durationMinutes = 10, tone = 'gentle' }) {
  const res = await fetch('/api/hypnosis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, durationMinutes, tone }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Preserve the { response: { data: { message } } } shape the UI reads.
    const err = new Error(data?.message || 'Request failed');
    err.response = { data, status: res.status };
    throw err;
  }

  return data;
}
