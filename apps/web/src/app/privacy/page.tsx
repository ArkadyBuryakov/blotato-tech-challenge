export default function Privacy() {
  return (
    <main className="main" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1>Privacy policy</h1>
      <p>This demo application connects to your Instagram professional account to run automations you configure.</p>
      <h2>What we store</h2>
      <ul>
        <li>Your Instagram account id, username and an encrypted access token.</li>
        <li>Automations you create and their versions.</li>
        <li>Comments and direct messages that reach your account, and the messages automations send, as an execution log.</li>
      </ul>
      <h2>What we do with it</h2>
      <p>Only execute your automations and show you their history. Data is not sold or shared with third parties.</p>
      <h2>Deletion</h2>
      <p>
        See <a href="/data-deletion/">data deletion</a>.
      </p>
    </main>
  );
}
