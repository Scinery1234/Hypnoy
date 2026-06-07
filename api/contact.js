import { sendContactNotification } from '../lib/resend.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { name, email, service, message } = req.body

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required' })
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  try {
    await sendContactNotification({ name, email, service, message })
    res.json({ success: true })
  } catch (err) {
    console.error('Contact email failed:', err)
    res.status(500).json({ error: 'Failed to send message' })
  }
}
