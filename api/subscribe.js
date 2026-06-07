import { supabase } from '../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { email, name } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  const { error } = await supabase.from('subscribers').upsert(
    { email, name: name || null, source: 'footer_form' },
    { onConflict: 'email', ignoreDuplicates: true }
  )
  if (error) return res.status(500).json({ error: error.message })

  if (process.env.KIT_API_KEY) {
    fetch('https://api.kit.com/v4/subscribers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.KIT_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email_address: email, first_name: name })
    }).catch(() => {})
  }

  res.json({ success: true })
}
