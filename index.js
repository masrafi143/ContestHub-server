const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");

// const serviceAccount = require("./contest-hub-firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors());
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  console.log("headers from middleware, ", req.headers.authorization);

  // if (!token) {
  //   return res.status(401).send({ message: "unauthorized access" });
  // }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vyznij5.mongodb.net/?appName=Cluster0`;
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vrmmuai.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("contest-hub_db");
    const contestsCollection = db.collection("contests");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const creatorsCollection = db.collection("creators");
    const winnersCollection = db.collection("winners");
    const statsCollection = db.collection("stats");
    const leaderboardCollection = db.collection("leaderboard");
    const taskSubmissionsCollection = db.collection("taskSubmissions");

    // middle admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };
    // USER APIs
    app.post("/users", async (req, res) => {
      const newUser = req.body;
      newUser.role = "user";
      usersCollection.createdAt = new Date();
      const email = req.body.email;
      const query = { email: email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        res.send({ message: "user already exist, no need to insert" });
      } else {
        const result = await usersCollection.insertOne(newUser);
        res.send(result);
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.get("/users", async (req, res) => {
      const email = req.query.email;
      console.log("Fetching transactions for:", email);
      const query = {};
      if (email) {
        query.email = email;
      }
      const cursor = usersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Update a user role by ID
    app.patch("/users-role/:id", async (req, res) => {
      const id = req.params.id;
      const updatedUser = req.body;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          role: updatedUser.role,
        },
      };
      const result = await usersCollection.updateOne(query, update);
      res.send(result);
    });

    // Update a user info by ID
    // app.patch("/users/:id", async (req, res) => {
    //   const id = req.params.id;
    //   const updatedUser = req.body;
    //   const query = { _id: new ObjectId(id) };
    //   const update = {
    //     $set: {
    //       name: updatedUser.name,
    //       email: updatedUser.email,
    //       role: updatedUser.role,
    //       image: updatedUser.image,
    //     },
    //   };
    //   const result = await usersCollection.updateOne(query, update);
    //   res.send(result);
    // });
    app.patch("/users/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { name, image, address } = req.body;

    const query = { _id: new ObjectId(id) };

    const updateFields = {};
    if (name) updateFields.name = name;
    if (image) updateFields.image = image;
    if (address !== undefined) updateFields.address = address;

    const update = { $set: updateFields };

    const result = await usersCollection.updateOne(query, update);

    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to update profile" });
  }
});


    //delete users
    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    // contest api
    app.get("/contests", async (req, res) => {
      const query = {};
      const { email } = req.query;
      // /parcels?email=''&
      if (email) {
        query.email = email;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = contestsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    //approved contest api
    // contest API - only confirmed contests
    app.get("/approved-contests", async (req, res) => {
      try {
        const query = { status: "confirmed" }; // only admin-approved
        const { email } = req.query;

        if (email) {
          query.email = email; // optional: filter by contest creator email
        }

        const options = { sort: { createdAt: -1 } }; // newest first
        const cursor = contestsCollection.find(query, options);
        const result = await cursor.toArray();

        res.send(result);
      } catch (err) {
        console.error("Error fetching contests:", err);
        res.status(500).send({ error: "Failed to fetch contests" });
      }
    });

    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.findOne(query);
      res.send(result);
    });

    app.post("/contests", async (req, res) => {
      const parcel = req.body;
      // parcel created at
      parcel.createdAt = new Date();
      const result = await contestsCollection.insertOne(parcel);
      res.send(result);
    });
    // Update a contest by ID
    app.patch("/contests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedContest = req.body;

        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            name: updatedContest.name,
            image: updatedContest.image,
            description: updatedContest.description,
            price: updatedContest.price,
            prize: updatedContest.prize,
            instruction: updatedContest.instruction,
            type: updatedContest.type,
            deadline: updatedContest.deadline, // ISO string
            status: updatedContest.status || "pending", // optional: keep default pending if not provided
          },
        };

        const result = await contestsCollection.updateOne(query, update);

        if (result.modifiedCount === 1) {
          res.send({ success: true, message: "Contest updated successfully!" });
        } else {
          res.send({
            success: false,
            message: "No changes made or contest not found.",
          });
        }
      } catch (err) {
        console.error("Error updating contest:", err);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    //update contest status
    app.patch("/contest-status/:id", async (req, res) => {
      const id = req.params.id;
      const updatedStatus = req.body;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: updatedStatus.status,
        },
      };
      const result = await contestsCollection.updateOne(query, update);
      res.send(result);
    });

    app.delete("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await contestsCollection.deleteOne(query);
      res.send(result);
    });

    // payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.name}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
        },
        participant_email: paymentInfo.email,
        success_url: `${process.env.SITE_DOMAIN}/contests/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/contests/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    // old
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.name,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.email,
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
          name: paymentInfo.name,
        },
        success_url: `${process.env.SITE_DOMAIN}/contests/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/contests/payment-cancelled`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      console.log("session retrieve", session);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }
      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.contestId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };

        const result = await contestsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          participant_email: session.customer_email,
          contestId: session.metadata.contestId,
          contestName: session.metadata.name,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          res.send({
            success: true,
            modifyContest: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }

      res.send({ success: false });
    });

    // payment related apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      console.log("headers", req.headers);

      if (email) {
        query.participant_email = email;
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // creators related apis
    app.get("/creators", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const cursor = creatorsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/creators", async (req, res) => {
      const creator = req.body;
      creator.status = "pending";
      creator.createdAt = new Date();

      const result = await creatorsCollection.insertOne(creator);
      res.send(result);
    });

    app.patch("/creators/:id", verifyFBToken, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
        },
      };

      const result = await creatorsCollection.updateOne(query, updatedDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "creator",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
      }

      res.send(result);
    });

    // winner related api
    // Add a winner (admin only)
    app.post("/winners", verifyFBToken, verifyAdmin, async (req, res) => {
      const { name, image, prize } = req.body;

      if (!name || !image || !prize) {
        return res.status(400).send({ message: "All fields are required" });
      }

      const winner = {
        name,
        image,
        prize: Number(prize),
        createdAt: new Date(),
      };

      const result = await winnersCollection.insertOne(winner);

      await statsCollection.updateOne(
        {},
        { $inc: { totalWinners: 1, totalPrize: Number(prize) } },
        { upsert: true }
      );

      res.send({ success: true, winner: result });
    });

    // Get recent winners (public)
    app.get("/winners/recent", async (req, res) => {
      const winners = await winnersCollection
        .find()
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();

      res.send(winners);
    });
    // Get winner stats
    app.get("/stats", async (req, res) => {
      const stats = await statsCollection.findOne();
      res.send(stats || { totalWinners: 0, totalPrize: 0 });
    });

    // leaderboard
    app.get("/leaderboard", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const totalCount = await leaderboardCollection.countDocuments();

        const leaders = await leaderboardCollection
          .find()
          .sort({ totalWins: -1 }) // highest wins first
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          data: leaders,
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          totalItems: totalCount,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to load leaderboard" });
      }
    });

    // submitted tasks
// POST /contests/:id/submit-task
app.post("/contests/:id/submit-task", async (req, res) => {
  try {
    const contestId = req.params.id;
    const { userEmail, taskSubmission } = req.body;

    if (!userEmail || !taskSubmission) {
      return res.status(400).send({ message: "Email and submission required" });
    }

    // Fetch contest name
    const contest = await client
      .db("contest-hub_db")
      .collection("contests")
      .findOne({ _id: new ObjectId(contestId) });

    if (!contest) return res.status(404).send({ message: "Contest not found" });

    // Fetch participant name from users collection
    const user = await client
      .db("contest-hub_db")
      .collection("users")
      .findOne({ email: userEmail });

    const submission = {
      contestId: new ObjectId(contestId),
      contestName: contest.name,
      participantName: user?.name || "Anonymous",
      participantEmail: userEmail,
      submission: taskSubmission,
      createdAt: new Date(),
      declaredWinner: false,
    };

    const result = await client
      .db("contest-hub_db")
      .collection("submittedTasks")
      .insertOne(submission);

    res.send({ success: true, submission: result });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to submit task" });
  }
});
// GET /submitted-tasks?creatorEmail=...
app.get("/submitted-tasks", async (req, res) => {
  try {
    const creatorEmail = req.query.creatorEmail;
    if (!creatorEmail) return res.status(400).send({ message: "creatorEmail required" });

    // Get contests of this creator
    const contests = await client
      .db("contest-hub_db")
      .collection("contests")
      .find({ email: creatorEmail })
      .toArray();

    const contestIds = contests.map(c => c._id);

    const submissions = await client
      .db("contest-hub_db")
      .collection("submittedTasks")
      .find({ contestId: { $in: contestIds.map(id => new ObjectId(id)) } })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(submissions);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch submissions" });
  }
});
// PATCH /submitted-tasks/:id/winner
app.patch("/submitted-tasks/:id/winner", async (req, res) => {
  try {
    const id = req.params.id;

    const submission = await client
      .db("contest-hub_db")
      .collection("submittedTasks")
      .findOne({ _id: new ObjectId(id) });

    if (!submission) return res.status(404).send({ message: "Submission not found" });

    // check if winner already exists for this contest
    const winnerExists = await client
      .db("contest-hub_db")
      .collection("submittedTasks")
      .findOne({ contestId: submission.contestId, declaredWinner: true });

    if (winnerExists) {
      return res.status(400).send({ message: "Winner already declared for this contest" });
    }

    const result = await client
      .db("contest-hub_db")
      .collection("submittedTasks")
      .updateOne({ _id: new ObjectId(id) }, { $set: { declaredWinner: true } });

    res.send({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to declare winner" });
  }
});



    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("contest hub is running!");
});

app.listen(port, () => {
  console.log(`contesthub app listening on port ${port}`);
});