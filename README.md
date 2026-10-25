# StudyPal: deploy guide

StudyPal is a study site with lessons, quizzes, key terms and an AI tutor for Algebra 1, Geometry, Algebra 2, Biology, AP Human Geography and English 1. The tutor can help with any subject.

This folder is a complete website. Deploy it to Vercel (free) and connect your own Claude API key. Total time: about 15 minutes.

```
studypal/
├── index.html     the whole website (pages, lessons, quizzes, styles)
├── api/ask.js     tiny server function that talks to Claude with your secret key
├── package.json
└── README.md      this guide
```

---

## Step 1: Get a Claude API key

1. Go to **console.anthropic.com** and create an account.
2. Open **Billing** and add a payment method, then add a small amount of credit (for example $5–10).
3. **Set a spending limit:** in **Settings → Limits**, set a monthly limit you're comfortable with. This is your safety net; the API stops working once the limit is reached, so you can never be surprised by a bill.
4. Open **API Keys → Create Key**, name it `studypal`, and copy the key (it starts with `sk-ant-`). Keep it secret. Never paste it into `index.html`.

The site uses **Claude Haiku 5.5** (`claude-haiku-5-5`), the fastest and lowest-cost model. Current prices: https://platform.claude.com/docs/en/about-claude/pricing

## Step 2: Put the project on GitHub (easiest path)

1. Create a free account at **github.com**.
2. Click **New repository**, name it `studypal`, choose **Private** or Public, and click **Create repository**.
3. Click **uploading an existing file**, drag in everything from this folder (including the `api` folder), and click **Commit changes**.

## Step 3: Deploy on Vercel

1. Go to **vercel.com** and sign up with your GitHub account.
2. Click **Add New → Project**, find `studypal`, and click **Import**.
3. Leave the framework setting as **Other**. Open **Environment Variables** and add:

   | Name | Value | Required? |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | your key from Step 1 | **Yes** |
   | `ACCESS_CODE` | a class code, e.g. `study2026` | Optional: visitors must enter it once before using the AI |
   | `DAILY_LIMIT` | e.g. `40` | Optional: questions per visitor per day (default 60) |
   | `MODEL` | e.g. `claude-sonnet-5-5` | Optional: use a stronger (pricier) model |

4. Click **Deploy**. In about a minute you'll get a link like `studypal-yourname.vercel.app`.

Open the link, type a question on the home screen, and watch the answer appear.

### Alternative: deploy from your terminal

If you have Node.js installed:

```bash
cd studypal
npx vercel                              # log in and create the project (accept defaults)
npx vercel env add ANTHROPIC_API_KEY    # paste your key; select Production, Preview and Development
npx vercel env add ACCESS_CODE          # optional
npx vercel --prod                       # publish
```

To test on your computer first: `npx vercel dev`, then open http://localhost:3000.

---

## Changing settings later

- **Change a setting** (key, class code, limit, model): Vercel → your project → **Settings → Environment Variables**, edit it, then **Deployments → ⋯ → Redeploy**.
- **Update the site:** replace `index.html` in your GitHub repo with a new version. Vercel redeploys automatically.
- **Use your own domain** (like `studypal.com`): Vercel → **Settings → Domains**.

## How it protects your money

1. **Your key stays secret.** It lives only in Vercel's settings, and the browser never sees it.
2. **Monthly spend limit** in the Anthropic Console: the hard stop.
3. **Daily question limit** per visitor (`DAILY_LIMIT`). It's best-effort: it's kept in server memory and can reset when Vercel restarts the function. For a strict limit later, add a free Upstash Redis database and store counts there.
4. **Optional class code** (`ACCESS_CODE`) keeps strangers from using your AI.

## Good to know

- **Progress** (lessons done, scores, quiz history, saved summaries) is saved in each student's own browser. It doesn't follow them to another device. Accounts that sync across devices can be added later with a free Supabase database.
- **Privacy:** questions and uploaded notes are sent to Anthropic's API to generate answers. Tell students not to enter personal information.
- **Students under 18:** if the site will be used by minors, review Anthropic's Usage Policy and its requirements for products used by minors: https://www.anthropic.com/legal/aup
- **Troubleshooting:**
  - "The site's AI isn't set up yet" means `ANTHROPIC_API_KEY` is missing or wrong. Fix it and redeploy.
  - "The AI is busy" means the API is temporarily overloaded or rate-limited. Wait a moment.
  - Nothing happens at all: in Vercel, open **Deployments → your deployment → Functions → api/ask** to see logs.
