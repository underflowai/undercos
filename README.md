# LinkedIn AI Slack Bot

A **proactive** AI assistant that automatically finds relevant LinkedIn content and people, drafts engagement, and asks for your approval—all in Slack.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     AUTOMATIC DISCOVERY                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Bot searches LinkedIn          Bot posts to Slack            │
│   (every hour for posts,    →    with draft comment/note   →   │
│   every 3 hours for people)      and action buttons            │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ 🔔 Found a relevant post                                │  │
│   │                                                         │  │
│   │ *Sarah Chen* • VP of Underwriting                       │  │
│   │ "The E&S market continues to evolve..."                 │  │
│   │                                                         │  │
│   │ *Draft comment:*                                        │  │
│   │ "Great insights, Sarah! We're seeing similar..."        │  │
│   │                                                         │  │
│   │ [💬 Comment]  [👍 Like]  [⏭️ Skip]                      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   You click "Comment" → Edit if needed → Posted!               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### 🔄 Automatic Discovery
- **Finds posts** matching your keywords (E&S, MGA, insurtech, etc.)
- **Finds people** matching your criteria (titles, companies)
- **Drafts comments** using AI (thoughtful, not "Great post!")
- **Drafts connection notes** personalized to each person
- **Pushes to Slack** with approve/edit/skip buttons

### 💬 Manual Commands
You can also ask directly:
```
@ai-li find posts about MGA technology
@ai-li search for underwriters at Specialty Risk
@ai-li draft a comment on this post: <url>
@ai-li should I connect with <profile>?
```

### 🛡️ Human-in-the-Loop
**Nothing happens without your approval.** Every action shows you:
- What it wants to do
- The draft content
- Buttons to approve, edit, or skip

## Setup

### 1. Create Slack App
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode + generate App-Level Token
3. Add Bot Token Scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`
4. Subscribe to Events: `app_mention`, `message.im`
5. Install to workspace

### 2. Set Up Unipile
1. Create account at [Unipile](https://developer.unipile.com/docs)
2. Get DSN + Access Token
3. Connect your LinkedIn account

### 3. Configure Environment

```bash
cp env.template .env
```

Edit `.env`:
```bash
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...

# For real LinkedIn actions
UNIPILE_ACCESS_TOKEN=...
UNIPILE_DSN=api1.unipile.com:13371

# For auto-discovery (recommended!)
DISCOVERY_CHANNEL_ID=C0123456789
DISCOVERY_MENTION_USER=U0123456789
```

### 4. Customize Discovery (Optional)

Edit `src/discovery/config.ts` to customize:

```typescript
{
  posts: {
    keywords: ['E&S insurance', 'MGA technology', 'insurtech'],
    minEngagement: 10,
    maxPostsPerRun: 5,
  },
  people: {
    searchQueries: ['VP underwriting MGA', 'insurance operations director'],
    targetTitles: ['VP', 'Director', 'CEO'],
  },
  schedule: {
    postsIntervalMinutes: 60,    // Check posts every hour
    peopleIntervalMinutes: 180,  // Check people every 3 hours
    activeHoursStart: 9,         // 9 AM
    activeHoursEnd: 18,          // 6 PM
    activeDays: [1,2,3,4,5],     // Mon-Fri
  },
}
```

### 5. Run

```bash
npm install
npm run dev
```

## What Happens

### With Auto-Discovery Enabled

| Time | What Happens |
|------|--------------|
| Every hour | Bot searches for posts matching your keywords |
| | Filters by engagement, excludes already-seen |
| | AI drafts a thoughtful comment |
| | Posts to your Slack channel with buttons |
| Every 3 hours | Bot searches for people matching your criteria |
| | Filters by title, excludes connected |
| | AI drafts personalized connection note |
| | Posts to your Slack channel with buttons |

### Your Workflow

1. **Get notification** in Slack
2. **Review** the draft
3. **Click** Approve / Edit / Skip
4. **Done** - bot handles the rest

## Project Structure

```
ai-linkedin/
├── src/
│   ├── index.ts              # Entry point
│   ├── config/env.ts         # Environment config
│   ├── discovery/
│   │   ├── config.ts         # What to look for
│   │   ├── scheduler.ts      # Timing/cron
│   │   ├── engine.ts         # Discovery logic
│   │   └── handlers.ts       # Slack button handlers
│   ├── slack/                # Slack integration
│   ├── agent/                # AI orchestration
│   ├── llm/                  # OpenAI client
│   └── tools/
│       ├── linkedin.ts       # LinkedIn tools
│       └── unipile.ts        # Unipile API client
└── package.json
```

## Modes

| Mode | When | What Happens |
|------|------|--------------|
| **Mock** | No Unipile credentials | Fake data, logs actions |
| **Live** | Unipile configured | Real LinkedIn actions |
| **Discovery Off** | No DISCOVERY_CHANNEL_ID | Manual commands only |
| **Discovery On** | Channel ID set | Proactive notifications |

## License

MIT
