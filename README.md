# Underflow Chief of Staff Bot

An AI-powered Slack assistant that handles LinkedIn outreach and email follow-ups for commercial insurance sales. Think of it as a 27-year-old McKinsey-trained chief of staff who manages your networking and follow-up cadence.

## What It Does

### LinkedIn Outreach
- **Finds relevant people** in commercial insurance (brokers, MGAs, wholesalers, carriers)
- **Drafts connection notes** using Claude Opus 4.5 with research-backed personalization
- **Surfaces profiles** in Slack with approve/edit/skip buttons
- **Tracks connections** and notifies when requests are accepted

### Email Follow-ups
- **Monitors calendar** for ended meetings with external attendees
- **Matches Day.ai notes** to draft personalized follow-up emails
- **Manages cadence** (Day 2-3, Day 7, Day 14, Day 21)
- **Tracks opens** and prioritizes warm leads

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SLACK INTERFACE                            │
├─────────────────────────────────────────────────────────────────────┤
│  LinkedIn Suggestions      │  Email Follow-ups                      │
│  ┌────────────────────┐   │  ┌────────────────────┐                │
│  │ *John Smith*       │   │  │ Meeting Follow-up: │                │
│  │ VP UW at Acme MGA  │   │  │ Ola <> Joe (Jencap)│                │
│  │                    │   │  │                    │                │
│  │ > building in      │   │  │ Key Points:        │                │
│  │ > wholesale ops    │   │  │ • Lloyd's timing   │                │
│  │                    │   │  │ • Portal issues    │                │
│  │ [Approve] [Edit]   │   │  │                    │                │
│  │ [View] [Skip]      │   │  │ [Send] [Edit]      │                │
│  └────────────────────┘   │  │ [Skip]             │                │
│                           │  └────────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐             ┌─────────────────┐
          │  Claude Opus 4.5│             │  OpenAI GPT-5.1 │
          │  (High Effort)  │             │  + Web Search   │
          │                 │             │                 │
          │  • Connection   │             │  • Research     │
          │    notes        │             │  • Classification│
          │  • Comments     │             │  • Agent tools  │
          │  • Emails       │             │                 │
          └─────────────────┘             └─────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                          ┌─────────────────┐
                          │    Unipile API  │
                          │                 │
                          │  • LinkedIn     │
                          │  • Gmail        │
                          │  • Calendar     │
                          └─────────────────┘
```

## Key Principles

Based on [Brian LaManna's](https://closedwon.xyz/) research (7x President's Club, #1 self-sourced deals at Gong):

1. **First 8 words are everything** - Preview text on mobile determines if they read
2. **Every follow-up must add insight** - Not "just checking in"
3. **Personality beats templates** - Claude Opus 4.5 for natural, human writing
4. **Quality over quantity** - 50 personalized emails > 1000 generic blasts

## Features

### LinkedIn Discovery
- AI-generated search queries based on your target market
- Relevance scoring (commercial insurance only, no personal lines)
- Full profile research (web search + LinkedIn activity)
- Connection notes that avoid "LinkedIn bot speak"
- Activity tracking to stay within platform limits

### Email Follow-ups
- **Meeting → Notes → Follow-up**: Matches Day.ai meeting notes to calendar events
- **Two-stage generation**: OpenAI web search for context, Claude for writing
- **Callback openers**: References specific details from the meeting
- **Smart cadence**: Day 2-3, 7, 14, 21 with different angles
- **Warm lead priority**: Tracks email opens, prioritizes engaged leads

### Sales Lead Tracking
- SQLite database for persistence
- Tracks: meeting context, email threads, follow-up count, open rates
- LinkedIn + email multi-channel coordination

### Webhooks (Real-time)
- Connection request accepted → Slack notification
- New DM received → Slack thread with reply option
- Email opened → Database update, warm lead flagging

## Setup

### Prerequisites
- Node.js 20+
- Slack workspace with app permissions
- [Unipile](https://unipile.com) account with LinkedIn + Gmail connected
- OpenAI API key
- Anthropic API key (for Claude Opus 4.5)

### 1. Clone & Install

```bash
git clone https://github.com/underflowai/undercos.git
cd undercos
npm install
```

### 2. Configure Environment

```bash
cp env.template .env
```

Edit `.env`:

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# AI
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Unipile (LinkedIn + Email)
UNIPILE_ACCESS_TOKEN=...
UNIPILE_DSN=api1.unipile.com:13371

# Discovery
DISCOVERY_CHANNEL_ID=C0123456789  # Slack channel for suggestions

# Webhooks (for real-time events)
WEBHOOK_URL=https://your-domain.com/webhooks/unipile
WEBHOOK_SECRET=your-secret
```

### 3. Create Slack App

Use the manifest in `slack-app-manifest.yaml` or manually configure:

**Bot Token Scopes:**
- `app_mentions:read`
- `chat:write`
- `im:history`, `im:read`, `im:write`

**Event Subscriptions:**
- `app_mention`
- `message.im`

**Interactivity:**
- Enable + set Request URL (for button actions)

### 4. Run

```bash
npm run dev
```

## Project Structure

```
src/
├── index.ts                 # Entry point
├── config/
│   ├── env.ts              # Environment validation
│   └── models.ts           # LLM configuration (Claude/OpenAI)
├── db/
│   ├── profiles.ts         # Surfaced profiles tracking
│   └── sales-leads.ts      # Sales lead + email tracking
├── discovery/
│   ├── engine.ts           # Main orchestrator
│   ├── people-discovery.ts # LinkedIn people search
│   ├── post-discovery.ts   # LinkedIn post search
│   ├── meeting-followup.ts # Calendar → Notes → Email
│   ├── lead-followup.ts    # Cadence engine
│   ├── prompts.ts          # All AI prompts
│   ├── handlers.ts         # Slack button handlers
│   └── activity-tracker.ts # Rate limiting
├── llm/
│   ├── responses.ts        # OpenAI Responses API
│   ├── anthropic.ts        # Claude Opus 4.5
│   └── content-generator.ts# Routes to Claude for writing
├── slack/
│   ├── app.ts              # Slack Bolt app
│   ├── handlers.ts         # Message handlers
│   └── linkedin-messaging.ts# DM thread handling
├── tools/
│   ├── linkedin.ts         # LinkedIn action tools
│   ├── email.ts            # Email send tools
│   └── unipile.ts          # Unipile API client
├── webhooks/
│   ├── server.ts           # Express webhook endpoint
│   ├── handlers.ts         # Event processors
│   └── setup.ts            # Auto-register webhooks
└── tracking/
    └── invitations.ts      # Track sent connection requests
```

## Configuration

### Model Settings (`src/config/models.ts`)

```typescript
// Claude Opus 4.5 for all writing tasks
WRITING_PRESET: 'claude_opus_high'

// OpenAI for agent orchestration
ACTIVE_PRESET: 'gpt51_optimized'
```

### Discovery Settings (`src/discovery/config.ts`)

```typescript
{
  posts: {
    enabled: true,
    maxPostsPerRun: 3,
    intervalMinutes: 60,
  },
  people: {
    enabled: true,
    maxPeoplePerRun: 5,
    intervalMinutes: 90,  // ~30 people/day during active hours
  },
  email: {
    enabled: true,
    checkMeetingNotesIntervalMinutes: 15,
    followUpCadenceIntervalMinutes: 240,
  },
  activeHours: {
    start: 9,   // 9 AM
    end: 18,    // 6 PM
    days: [1, 2, 3, 4, 5], // Mon-Fri
  }
}
```

## Deployment

### Railway

1. Connect repo to Railway
2. Set environment variables
3. Deploy - Railway auto-detects Node.js
4. Update `WEBHOOK_URL` with Railway domain

### Manual

```bash
npm run build
npm start
```

## Database

SQLite databases in `data/`:
- `profiles.db` - Surfaced LinkedIn profiles + actions
- `sales-leads.db` - Sales leads + email tracking

## Activity Limits

Follows LinkedIn best practices:
- **Invitations**: 100/week recommended
- **Messages**: 100-150/day
- **Searches**: 100/day recommended
- **Active hours only**: 9am-6pm Mon-Fri

## License

MIT
