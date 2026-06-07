import bcrypt from 'bcryptjs'
import { signToken } from '../../lib/auth.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' })
  }

  if (email !== process.env.ADMIN_EMAIL) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const valid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH)
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

  const token = signToken({ email, role: 'admin' })
  res.json({ token })
}
