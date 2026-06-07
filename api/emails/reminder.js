import { supabase } from '../../lib/supabase.js'
import { sendReminder24h, sendReminder1h, sendFollowUp } from '../../lib/resend.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const in1h  = new Date(now.getTime() +      60 * 60 * 1000)
  const ago2h = new Date(now.getTime() -  2 * 60 * 60 * 1000)

  const { data: bookings } = await supabase
    .from('bookings')
    .select('*, clients(*), session_types(name)')
    .eq('status', 'confirmed')

  const sent = { reminder24h: 0, reminder1h: 0, followup: 0 }

  for (const booking of bookings ?? []) {
    const sessionStart = new Date(`${booking.date}T${booking.start_time}`)
    const sessionEnd   = new Date(sessionStart.getTime() + booking.duration_mins * 60000)

    const diff24 = Math.abs(sessionStart - in24h)
    if (!booking.reminder_24h_sent && diff24 < 10 * 60 * 1000) {
      await sendReminder24h({ booking: { ...booking, session_type_name: booking.session_types.name }, client: booking.clients })
      await supabase.from('bookings').update({ reminder_24h_sent: true }).eq('id', booking.id)
      sent.reminder24h++
    }

    const diff1h = Math.abs(sessionStart - in1h)
    if (!booking.reminder_1h_sent && diff1h < 10 * 60 * 1000) {
      await sendReminder1h({ booking: { ...booking, session_type_name: booking.session_types.name }, client: booking.clients })
      await supabase.from('bookings').update({ reminder_1h_sent: true }).eq('id', booking.id)
      sent.reminder1h++
    }

    if (!booking.followup_sent && sessionEnd < ago2h) {
      await sendFollowUp({ booking, client: booking.clients })
      await supabase.from('bookings')
        .update({ followup_sent: true, status: 'completed' })
        .eq('id', booking.id)
      sent.followup++
    }
  }

  res.json({ success: true, sent, checked: bookings?.length ?? 0 })
}
