# Reliable Event-Driven — Transactional Outbox Pattern

A production-ready Node.js microservices demo that guarantees **at-least-once delivery** of domain events without two-phase commit, using the **Transactional Outbox Pattern**.

---

## Architecture Overview

### What is the Transactional Outbox Pattern?

In a distributed system, saving a record to the database **and** publishing an event to a message broker are two separate operations. If the service crashes between the two, or if the broker is temporarily unreachable, the event is lost and the two systems diverge.

The Transactional Outbox Pattern solves this by:

1. **Writing the event to an "outbox" table/collection in the same database transaction as the business data.** Either both the user row and the outbox row are committed, or neither is — the database's ACID guarantee keeps them in sync.
2. **Running a background "relay" worker** that polls the outbox for `PENDING` events and publishes them to the broker. Only after the broker **confirms** receipt does the worker mark the event as `SENT`.
3. Because the worker retries indefinitely, the system provides **at-least-once delivery**. The consumer must be **idempotent** (it handles receiving the same event more than once without side effects).

### ASCII Flow Diagram

```
┌─────────┐   POST /register   ┌─────────────────────────────────────────────┐
│ Client  │──────────────────▶ │              Auth Service                   │
└─────────┘                    │                                             │
                               │  ┌──────────────────────────────────────┐   │
                               │  │   MongoDB Transaction (rs0)          │   │
                               │  │                                      │   │
                               │  │  1. INSERT users { email, password } │   │
                               │  │  2. INSERT outbox { status:PENDING } │   │
                               │  └──────────────────────────────────────┘   │
                               │                                             │
                               │  ┌──────────────────────────────────────┐   │
                               │  │   Outbox Relay Worker (every 5s)     │   │
                               │  │                                      │   │
                               │  │  POLL outbox WHERE status=PENDING    │   │
                               │  │  PUBLISH to RabbitMQ (confirm chan.) │   │
                               │  │  On ACK → UPDATE status=SENT         │   │
                               │  └──────────────────────────────────────┘   │
                               └─────────────────────────────────────────────┘
                                                     │
                                                     ▼
                                           ┌──────────────────┐
                                           │    RabbitMQ      │
                                           │  queue:          │
                                           │  user_registered │
                                           │  (durable)       │
                                           └──────────────────┘
                                                     │
                                                     ▼
                               ┌─────────────────────────────────────────────┐
                               │              Todo Service                   │
                               │                                             │
                               │  ┌──────────────────────────────────────┐   │
                               │  │   Consumer (prefetch=1, manual ack)  │   │
                               │  │                                      │   │
                               │  │  1. Check if welcome todo exists     │   │
                               │  │     (idempotency check)              │   │
                               │  │  2. If not → INSERT todos            │   │
                               │  │  3. ACK message                      │   │
                               │  └──────────────────────────────────────┘   │
                               └─────────────────────────────────────────────┘
                                                     │
                                                     ▼
                                        ┌────────────────────┐
                                        │  MongoDB (tododb)  │
                                        │  todos collection  │
                                        └────────────────────┘
```

### Services

| Service | Role | Port |
|---|---|---|
| **auth-service** | Registers users; writes User + Outbox atomically; relays outbox events | 3001 |
| **todo-service** | Consumes `USER_REGISTERED` events; creates a welcome todo idempotently | — |
| **mongo1/2/3** | MongoDB 6 Replica Set (required for multi-document transactions) | 27017/18/19 |
| **rabbitmq** | Message broker with management UI | 5672 / 15672 |

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 20.x
- [Docker Compose](https://docs.docker.com/compose/install/) ≥ 2.x (V2 syntax)
- `curl` or [Postman](https://www.postman.com/) for testing

---

## How to Run

### 1. Clone / download the project

```bash
git clone https://github.com/Dheerendra-dev01/reliable-event-driven
cd reliable-event-driven
```

### 2. Start all services

```bash
docker-compose up --build
```

Docker Compose will:
- Build the `auth-service` and `todo-service` images
- Start `mongo1`, `mongo2`, `mongo3` (MongoDB replica set nodes)
- Run `mongo-init` once to call `rs.initiate()` and form the replica set
- Start `rabbitmq` and wait for it to pass its health check
- Start `auth-service` and `todo-service` once RabbitMQ is healthy

> First startup takes ~60–90 seconds while MongoDB elects a primary and RabbitMQ initializes.

### 3. Verify all services are healthy

```bash
# RabbitMQ management UI
open http://localhost:15672   # login: guest / guest

# Auth service health check
curl http://localhost:3001/health
# Expected: {"status":"ok","service":"auth-service"}

# Check container statuses
docker-compose ps
```

---

## How to Test the Happy Path

### Step 1 — Register a user

```bash
curl -s -X POST http://localhost:3001/register \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "secret123"}' | jq
```

Expected response:

```json
{
  "message": "User registered",
  "userId": "64f1a2b3c4d5e6f7a8b9c0d1"
}
```

### Step 2 — Verify the user was created in MongoDB

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use authdb;
  db.users.find({}, { password: 0 }).pretty();
"
```

### Step 3 — Verify the outbox event was created and eventually marked SENT

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use authdb;
  db.outboxes.find().pretty();
"
```

Within ~5 seconds the relay worker will publish the event and the status changes from `PENDING` → `SENT`.

### Step 4 — Verify the welcome todo was created in the todo-service

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use tododb;
  db.todos.find().pretty();
"
```

Expected document:

```json
{
  "_id": "...",
  "userId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "title": "Welcome to the App",
  "type": "WELCOME",
  "completed": false,
  "createdAt": "..."
}
```

### Step 5 — Check RabbitMQ management UI

Visit [http://localhost:15672](http://localhost:15672) (guest/guest). Navigate to **Queues** — you should see `user_registered` with 0 ready messages (all consumed).

---

## How to Simulate a Failure (Broker Down Test)

This test proves the Transactional Outbox Pattern's core value: **data is never lost even if the broker is unreachable when the user registers**.

### Step 1 — Stop RabbitMQ

```bash
docker-compose stop rabbitmq
```

### Step 2 — Register a new user (broker is down)

```bash
curl -s -X POST http://localhost:3001/register \
  -H "Content-Type: application/json" \
  -d '{"email": "bob@example.com", "password": "secret456"}' | jq
```

The registration **succeeds** — the User and Outbox documents are written atomically to MongoDB. The relay worker will log errors like:
```
[outboxRelay] Failed to publish event ... Leaving status as PENDING — will retry on next tick.
```

### Step 3 — Confirm the user exists but the outbox is still PENDING

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use authdb;
  print('-- Users --');
  db.users.find({ email: 'bob@example.com' }, { password: 0 }).pretty();
  print('-- Outbox --');
  db.outboxes.find({ status: 'PENDING' }).pretty();
"
```

The user document exists. The outbox document has `status: "PENDING"`. **No event loss.**

### Step 4 — Restart RabbitMQ

```bash
docker-compose start rabbitmq
```

Wait ~15 seconds for RabbitMQ to become healthy again.

### Step 5 — Watch the relay worker pick up the PENDING event

In the `docker-compose up` terminal (or via `docker-compose logs -f auth-service`) you will see:

```
[outboxRelay] Found 1 PENDING event(s). Attempting to relay...
[outboxRelay] Event 64f... (USER_REGISTERED) published and marked SENT.
```

### Step 6 — Verify the welcome todo was eventually created

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use tododb;
  db.todos.find({ userId: { \$exists: true } }).pretty();
"
```

The todo for `bob` is present — **fault tolerance proven**.

---

## How to Test Idempotency

The todo-service must handle duplicate message delivery without creating duplicate todos.

### Using the RabbitMQ Management UI

1. Open [http://localhost:15672](http://localhost:15672) → **Queues** → `user_registered`
2. Click **Publish message**
3. Paste the same payload that was originally sent, e.g.:
   ```json
   {"userId": "64f1a2b3c4d5e6f7a8b9c0d1", "email": "alice@example.com"}
   ```
4. Click **Publish**

The todo-service consumer will log:

```
[userRegistered] Welcome todo already exists for userId=64f1a2b3c4d5e6f7a8b9c0d1. Skipping creation. (idempotent)
```

### Confirm only one todo exists

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "
  use tododb;
  db.todos.countDocuments({ userId: '64f1a2b3c4d5e6f7a8b9c0d1', type: 'WELCOME' });
"
```

Output: `1` — exactly one welcome todo regardless of how many times the message was delivered.

#### Why it is safe

Two idempotency guards stack on top of each other:

1. **Application layer** (`userRegistered.js`): `Todo.findOne({ userId, title, type })` before creating.
2. **Database layer** (`Todo.js`): a unique compound index on `{ userId: 1, type: 1 }` that rejects duplicate writes with an `11000` duplicate key error, which the consumer handles gracefully by acking the message.

---

## MongoDB Commands to Inspect Data

### Open a `mongosh` shell on the primary

```bash
docker exec -it mongo1 mongosh --port 27017
```

### Switch databases and inspect collections

```js
// Auth database
use authdb

// All registered users (passwords hidden)
db.users.find({}, { password: 0 }).pretty()

// All outbox events
db.outboxes.find().pretty()

// Only PENDING events
db.outboxes.find({ status: "PENDING" }).pretty()

// Only SENT events
db.outboxes.find({ status: "SENT" }).pretty()

// Todo database
use tododb

// All todos
db.todos.find().pretty()

// Todos for a specific user
db.todos.find({ userId: "<paste-userId-here>" }).pretty()

// Count todos per user
db.todos.aggregate([{ $group: { _id: "$userId", count: { $sum: 1 } } }])
```

### Check replica set status

```bash
docker exec -it mongo1 mongosh --port 27017 --eval "rs.status()"
```

### Tear down everything (including volumes)

```bash
docker-compose down -v
```

---

## Project Structure

```
reliable-event-driven/
├── docker-compose.yml
├── README.md
├── mongo-init/
│   └── init-replica.sh           # Initializes MongoDB rs0 replica set
├── auth-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js              # Express entry point + starts outbox relay
│       ├── config/db.js          # Mongoose connection with retry
│       ├── models/User.js        # User schema
│       ├── models/Outbox.js      # Outbox schema
│       ├── routes/auth.js        # POST /register route
│       ├── controllers/authController.js  # Transaction: User + Outbox
│       └── workers/outboxRelay.js         # Polling relay → RabbitMQ confirm
└── todo-service/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── index.js              # Starts DB connection + consumer
        ├── config/db.js          # Mongoose connection with retry
        ├── models/Todo.js        # Todo schema with unique compound index
        └── consumers/userRegistered.js   # Idempotent RabbitMQ consumer
```

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| MongoDB Replica Set | Required for multi-document ACID transactions (`session.startTransaction()`) |
| Outbox in same DB transaction | Guarantees User and Outbox are always in sync — no partial writes |
| RabbitMQ confirm channel | `waitForConfirms()` ensures the broker has persisted the message before marking it `SENT` |
| `status: PENDING` left on broker failure | The relay retries on the next tick — at-least-once delivery without data loss |
| `noAck: false` in consumer | Manual acks prevent message loss if the consumer crashes mid-processing |
| Unique compound index `{ userId, type }` | Database-level idempotency guard against duplicate todo creation |
| No `process.exit()` in workers | Workers retry connection failures rather than crashing the container |
# reliable-event-driven
