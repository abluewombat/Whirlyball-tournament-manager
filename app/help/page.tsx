import { requireStaff } from "@/lib/auth";

const centerFaqs = [
  ["What does approving a registration do?", "Approval creates or updates the tournament player entry and assigns the player to the team you select. Review the requested division, shirt size, and notes before approving."],
  ["Can a player appear on more than one team?", "The normal workflow assumes one team per player. Nationals Unlimited players may also belong to an A team when the tournament requires it."],
  ["What if a team or player needs a change later?", "Make the change from the center dashboard. Public registrants cannot edit an approved request themselves."],
  ["What are availability blocks?", "They tell the tournament admin that a team cannot play during a specific period. Add them before schedule generation whenever possible."],
  ["Why can I not edit an old tournament?", "Past tournaments are retained as permanent archives. A tournament admin must reopen editing before operational data can change."]
];

const adminFaqs = [
  ["When should I take a snapshot?", "Take one before a large roster change, schedule regeneration, draft lock, or other major operation. Restoring a snapshot replaces tournament state with that saved version."],
  ["Can I regenerate the schedule?", "Yes, until recorded results make regeneration unsafe. Confirm teams, availability, courts, dates, and game lengths first."],
  ["When should I generate brackets?", "After all applicable seeding games are final. Bracket generation locks those seeding results unless the bracket is rebuilt or voided."],
  ["How do stream timestamps advance?", "Saving a stream URL currently starts the first unscored game on that court. Each game's first final score ends that game and starts the next ready game. Score corrections do not advance twice."],
  ["Does the YouTube key need to own the channel?", "No. A generic server-side YouTube Data API key can read public stream timing. Keep it in Vercel as YOUTUBE_API_KEY and never expose it as a NEXT_PUBLIC variable."],
  ["What should the streamer enable?", "Schedule each court/day broadcast in advance, enable DVR and recording, use Public or Unlisted visibility, and keep each stream under 12 hours when possible."],
  ["What happens to completed tournaments?", "They remain publicly viewable. Only one tournament is active at a time, and the admin chooses each tournament's URL slug."]
];

function FaqSection({ items }: { items: string[][] }) {
  return (
    <div className="faq-list">
      {items.map(([question, answer]) => (
        <details className="card faq-item" key={question}>
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      ))}
    </div>
  );
}

export default async function HelpPage() {
  const access = await requireStaff();

  if (access.role === "center") {
    return (
      <main className="content help-page">
        <section className="card">
          <p className="eyebrow">Center Administrator Manual</p>
          <h1>{access.centerName} Operations Guide</h1>
          <p className="muted">How to manage registrations, teams, rosters, shirts, and availability.</p>
        </section>

        <section className="section help-grid">
          <article className="card">
            <h2>1. Review registration requests</h2>
            <ol>
              <li>Open the Center Dashboard and select the correct tournament.</li>
              <li>Review each pending individual, partial-team, or full-team request.</li>
              <li>Choose the destination team and division where required.</li>
              <li>Approve or reject the request. Check names and shirt sizes before approval.</li>
            </ol>
          </article>
          <article className="card">
            <h2>2. Build and maintain teams</h2>
            <ol>
              <li>Create the center's teams and choose the correct division.</li>
              <li>Add players directly or approve public requests into those teams.</li>
              <li>Keep each competitive roster at five players.</li>
              <li>Update payment, shirt, and notes fields as information arrives.</li>
            </ol>
          </article>
          <article className="card">
            <h2>3. Submit availability</h2>
            <ol>
              <li>Record any periods when a team cannot play.</li>
              <li>Use accurate start and end times and add a useful reason.</li>
              <li>Coordinate late changes with the tournament admin after scheduling begins.</li>
            </ol>
          </article>
          <article className="card">
            <h2>4. Final review</h2>
            <ol>
              <li>Confirm player spelling, roster assignments, and shirt sizes.</li>
              <li>Check the public team pages to verify what players will see.</li>
              <li>Notify the tournament admin when your center is ready for scheduling.</li>
            </ol>
          </article>
        </section>

        <section className="section">
          <h2>Center Admin FAQ</h2>
          <FaqSection items={centerFaqs} />
        </section>
      </main>
    );
  }

  return (
    <main className="content help-page">
      <section className="card">
        <p className="eyebrow">Tournament Administrator Manual</p>
        <h1>Operations Guide</h1>
        <p className="muted">A practical sequence from tournament setup through archived results.</p>
      </section>

      <section className="section help-grid">
        <article className="card">
          <h2>1. Create the tournament</h2>
          <ol>
            <li>Create the event under Tournaments with its name, slug, type, dates, location, and registration deadline.</li>
            <li>Configure divisions. Nationals normally use A, B, C, D, and Unlimited; draft events can use optional level names.</li>
            <li>Set center passcodes and the scorekeeper passcode.</li>
            <li>Mark the correct event active when it should appear at the main site URL.</li>
          </ol>
        </article>
        <article className="card">
          <h2>2. Complete registration</h2>
          <ol>
            <li>Monitor center teams, players, public requests, shirts, payments, and availability.</li>
            <li>Override center data only when a correction is needed.</li>
            <li>For draft events, assign player levels, create teams, fill five-player rosters, and lock the draft.</li>
            <li>Take a snapshot before major changes.</li>
          </ol>
        </article>
        <article className="card">
          <h2>3. Generate the schedule</h2>
          <ol>
            <li>Confirm teams, courts, game durations, dates, and availability first.</li>
            <li>Generate round-robin seeding and review unscheduled games or conflicts.</li>
            <li>Use the schedule editor for necessary court or time adjustments.</li>
            <li>Publish operational announcements from the dashboard.</li>
          </ol>
        </article>
        <article className="card">
          <h2>4. Run scorekeeping</h2>
          <ol>
            <li>Give operators the shared scorekeeper passcode.</li>
            <li>Add each court/day YouTube URL in Score Entry.</li>
            <li>Enter each final score once. The standings and court timeline update automatically.</li>
            <li>Use the forfeit controls when applicable and correct mistakes carefully.</li>
          </ol>
        </article>
        <article className="card">
          <h2>5. Run brackets</h2>
          <ol>
            <li>Finish all required seeding games before generating brackets.</li>
            <li>Generate the double-elimination brackets and synchronize their schedule slots.</li>
            <li>Score bracket games through Score Entry so winners advance correctly.</li>
            <li>Unlimited is exhibition-only and does not use seeding.</li>
          </ol>
        </article>
        <article className="card">
          <h2>6. Close and archive</h2>
          <ol>
            <li>Verify final scores, standings, brackets, and video replay links.</li>
            <li>Export tournament data and take a final labeled snapshot.</li>
            <li>Mark the event past. Its public pages remain available through its slug.</li>
            <li>Create the next tournament without deleting prior event data.</li>
          </ol>
        </article>
      </section>

      <section className="section">
        <h2>Tournament Admin FAQ</h2>
        <FaqSection items={adminFaqs} />
      </section>
    </main>
  );
}
