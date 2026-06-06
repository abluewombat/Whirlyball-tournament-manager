import { requireStaff } from "@/lib/auth";

const centerFaqs = [
  ["What does approving a registration do?", "Approval creates or updates the tournament player entry and assigns the player to the team you select. Review the requested division, shirt size, and notes before approving."],
  ["Can a player appear on more than one team?", "The normal workflow assumes one team per player. Nationals Unlimited players may also belong to an A team when the tournament requires it."],
  ["What if a team or player needs a change later?", "Make the change from the center dashboard. Public registrants cannot edit an approved request themselves."],
  ["What are availability blocks?", "They tell the tournament admin that a team cannot play during a specific period. Add them before schedule generation whenever possible."],
  ["Why can I not edit an old tournament?", "Past tournaments are retained as permanent archives. A tournament admin must reopen editing before operational data can change."]
];

const adminFaqs = [
  ["How do I find a game?", "Use the day, division, team, or court filters. By default, completed games are hidden so the remaining games are easy to find."],
  ["What if I enter the wrong score?", "Choose Show All Seeding Games or Show All Tournament Games, find the completed game, and update or reset its score. Ask the tournament director before changing a bracket result that has already advanced another team."],
  ["What if a team forfeits?", "Use the Forfeit button for the team that forfeited. Do not enter a made-up score."]
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
        <p className="eyebrow">Scorekeeper Guide</p>
        <h1>How to Enter Scores</h1>
        <p className="muted">The schedule is ready. Your only job is to enter each completed game's result.</p>
      </section>

      <section className="section help-grid">
        <article className="card">
          <h2>1. Open Score Entry</h2>
          <ol>
            <li>Open Manage, then Score Entry.</li>
            <li>Enter the shared scorekeeper passcode if prompted.</li>
            <li>Use the court, team, or division filters to find the game.</li>
          </ol>
        </article>
        <article className="card">
          <h2>2. Save the Final Score</h2>
          <ol>
            <li>Confirm both team names before entering anything.</li>
            <li>Enter each team's final score.</li>
            <li>Select Save Score once.</li>
            <li>The completed game disappears from the default list.</li>
          </ol>
        </article>
        <article className="card">
          <h2>3. Handle Exceptions</h2>
          <ol>
            <li>For a forfeit, select the button for the team that forfeited.</li>
            <li>For a mistake, show completed games and correct or reset the result.</li>
            <li>Do not change a locked result. Contact the tournament director.</li>
          </ol>
        </article>
      </section>

      <section className="section">
        <h2>Score Entry FAQ</h2>
        <FaqSection items={adminFaqs} />
      </section>
    </main>
  );
}
