# Volo Soccer Drop-In Monitor

This project opens your exact filtered Volo page in headless Chrome every five
minutes. It sends an urgent ntfy notification to your phone when a matching
listing appears.

## What it does

- Runs in GitHub's cloud; your computer can be off.
- Renders Volo's JavaScript application in Chrome.
- Uses the filters contained in the Volo URL you provide.
- Looks for Soccer + Drop-In cards with a positive generic or men's spot count.
- Ignores Volo's "doesn't match all your filters" recommendation section.
- Alerts only when a listing newly appears.
- Does not repeat the same alert every five minutes.
- Alerts again if a listing disappears and later reappears.
- Sends at most one failure notification per day.
- Saves its small state file back to the repository.

## Important limitation

GitHub's shortest supported scheduled-workflow interval is five minutes.
Scheduled jobs can occasionally start late during periods of high GitHub load.
This is the strongest fully free browser-rendering setup that does not require
your own computer or server to remain on.

## 1. Build and verify the exact Volo URL

On the Volo website:

1. Select Denver.
2. Open Daily Sports.
3. Set Sport to Soccer.
4. Set Program Type to Drop-In.
5. Set the participant selection to 1 Men.
6. Copy the complete URL from the address bar.
7. Paste that URL into an Incognito window.

Do not continue until the Incognito window opens with the same filters. The
cloud browser starts with no cookies or local browser state, so the filters must
survive when the URL is opened in a fresh browser.

A Soccer + Drop-In URL may resemble:

```text
https://www.volosports.com/discover?cityName=Denver&programTypes=DROPIN&sportNames%5B0%5D=Soccer&subView=DAILY&view=SPORTS
```

Use the URL copied from your own fully filtered page, not the example, because
Volo may add another query parameter for the 1 Men selection.

## 2. Set up phone notifications

1. Install the **ntfy** app from the iPhone App Store or Google Play.
2. Generate a long random topic name.

PowerShell:

```powershell
$topic = "volo-" + [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$topic
```

macOS/Linux:

```bash
TOPIC="volo-$(openssl rand -hex 32)"
echo "$TOPIC"
```

3. In the ntfy app, tap **Subscribe to topic**.
4. Enter the exact generated topic.
5. Enable ntfy notifications in your phone's system settings.

Do not use a short or guessable topic. Public ntfy topics can be subscribed to
by anyone who knows the topic name.

Optional PowerShell test:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "https://ntfy.sh/$topic" `
  -Headers @{ Title = "Volo test"; Priority = "5" } `
  -Body "Phone notifications are working."
```

## 3. Create the public GitHub repository

The repository must be public for standard GitHub-hosted runner usage to remain
free without consuming the private-repository monthly minute quota. The ntfy
topic is stored as an encrypted GitHub secret and is not committed.

Unzip this project and run:

```bash
cd volo-dropin-monitor
git init
git add .
git commit -m "Add Volo drop-in monitor"
gh auth login
gh repo create volo-dropin-monitor --public --source=. --remote=origin --push
```

You can instead create a public repository through github.com and push these
files normally.

## 4. Add the repository secret and variable

### Using the GitHub CLI

Set the ntfy topic as a secret:

PowerShell:

```powershell
gh secret set NTFY_TOPIC --body "$topic"
```

macOS/Linux:

```bash
gh secret set NTFY_TOPIC --body "$TOPIC"
```

Set your exact Volo filtered URL as a repository variable:

```bash
gh variable set VOLO_URL --body "PASTE_YOUR_COMPLETE_FILTERED_VOLO_URL_HERE"
```

### Using GitHub's website

Open the repository and go to:

**Settings → Secrets and variables → Actions**

Under **Secrets**, create:

```text
Name: NTFY_TOPIC
Value: your long random ntfy topic
```

Under **Variables**, create:

```text
Name: VOLO_URL
Value: your complete filtered Volo URL
```

## 5. Run the first test manually

Using the GitHub CLI:

```bash
gh workflow run "Volo Drop-In Monitor"
gh run watch
```

Or open:

**Actions → Volo Drop-In Monitor → Run workflow**

Expected behavior:

- When no matching game exists, the first run sends one
  **Volo monitor active** notification.
- When matching games exist, the first run alerts you about each current game.
- The workflow log prints `matches` and a `pagePreview` for debugging.
- `state.json` is committed by `github-actions[bot]`.

Tap an availability notification. It should open the Volo listing or the
filtered Volo page.

## 6. Verify the scheduled checks

After the manual run succeeds, no further action is needed. The workflow runs
at minutes 2, 7, 12, 17, and so on.

Open the repository's **Actions** tab later and confirm scheduled runs are
appearing. GitHub can occasionally delay scheduled jobs. The code creates a
monthly state commit so the public repository does not sit inactive for 60 days.

## How duplicate prevention works

`state.json` contains the listings seen during the previous successful check.

- Same listing still present: no new notification.
- New listing appears: notification is sent.
- Listing disappears: it is removed from state.
- The listing later returns: it is treated as new and alerts again.

## If Volo visibly has a qualifying game but the log says zero matches

Open the latest workflow:

1. Open **Actions**.
2. Select the latest Volo monitor run.
3. Open the **Check Volo and send alerts** step.
4. Inspect `pagePreview` and `matches`.

This monitor deliberately requires the card text to contain:

- `Soccer`
- `Drop-In`
- a weekday or a time
- a positive `spot` count or a men's count such as `Men: 1`

If Volo changes those labels or page structure, update the matching rules in
`monitor.mjs`. A parsing or rendering failure sends one phone warning per day.

## Security notes

- Never put your ntfy topic directly in the repository.
- This monitor does not need your Volo password.
- It watches the public Discover page only.
- The repository state contains only public event names and links.
