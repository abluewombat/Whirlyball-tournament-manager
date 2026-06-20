const faqs = [
  {
    question: "Where do I find teams, schedules, and standings?",
    answer: "Use the Public navigation at the top of the site. Team pages show rosters, scheduled games, reffing assignments, results, and replay links when video timestamps are available."
  },
  {
    question: "How do I register for a tournament?",
    answer: "Open Register, choose your home center, and submit yourself, a partial team, or a full team when registration is open. Your center admin reviews the request. Only one pending request per person is allowed for a tournament."
  },
  {
    question: "Can I change my registration after submitting it?",
    answer: "Contact your center admin. Changes after submission are handled by an administrator rather than through a second public request."
  },
  {
    question: "Why is registration closed?",
    answer: "Registration closes on the deadline set by the tournament admin, or when the tournament or draft has been locked."
  },
  {
    question: "When will the schedule appear?",
    answer: "The public schedule appears after the tournament admin generates it. Schedule changes are reflected automatically."
  },
  {
    question: "How do livestream and replay links work?",
    answer: "When a court has a YouTube stream, the current game appears in Live Now. Completed games can show a replay link that opens near the estimated start of that game."
  },
  {
    question: "Are replay timestamps exact?",
    answer: "They are estimates driven by court stream timing and score entry. They should get viewers close to the game, but may include setup time or the end of the previous game."
  },
  {
    question: "Why can I still see an old tournament?",
    answer: "Past tournaments remain permanently viewable. Use the tournament selector in Public navigation to switch between available events."
  },
  {
    question: "Who should I contact if a roster or score is wrong?",
    answer: "Contact your center admin for roster questions. Tournament admins and authorized scorekeepers handle scoring and schedule corrections."
  }
];

export default function FaqPage() {
  return (
    <main className="content help-page">
      <section className="card">
        <p className="eyebrow">Public Help</p>
        <h1>Frequently Asked Questions</h1>
        <p className="muted">Quick answers for players, teams, and spectators.</p>
      </section>

      <section className="section faq-list">
        {faqs.map((faq) => (
          <details className="card faq-item" key={faq.question}>
            <summary>{faq.question}</summary>
            <p>{faq.answer}</p>
          </details>
        ))}
      </section>

      <section className="section card compact">
        <h2>Are you an administrator?</h2>
        <p className="muted">Tournament and center administrators can open the role-specific manual after logging in.</p>
        <div className="actions">
          <a className="button secondary" href="/login?mode=center">Center Login</a>
          <a className="button secondary" href="/login?mode=admin">Tournament Admin Login</a>
        </div>
      </section>
    </main>
  );
}
