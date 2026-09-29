require("dotenv").config({ path: "../.env" });

global._ = require("lodash");
global.Path = require("path");
global.Fs = require("fs-extra");
global.Logger = require("./utils/logger");

const Config = require("./config/config");
global.Config = Config;

require("./utils/global");
require("./utils/constants");

global.MSG = require("./locals/en/messages");
global.Func = require("./utils/functions");
global.Notifications = require('./utils/notification')
global.IS_APP_PROCESS = false;
global.Models = require("./models");

/* ✅ REQUIRED SERVICES */
global.Services = {
  Merchant: require("./services/Merchant"),
  Order: require("./services/Order"),
  WebhookError: require("./services/WebhookError"),
  ShopifySession: require("./services/ShopifySession"),
  // ✅ Required by handleOrderCreate (called during legacy order auto-import)
  Branding: require("./services/Branding"),
  Billing: require("./services/Billing"),
  UsageRecord: require("./services/UsageRecord"),
  LineItemTracking: require("./services/LineItemTracking"),
  Webhook: require("./services/Webhook"),
  Task: require("./services/Task"),
  Widget: require("./services/Widget"),
  Region: require("./services/Region"),
  Event: require("./services/Event"),
  User: require("./services/User"),
  DeletionLog: require("./services/DeletionLog"),
  OTP: require("./services/OTP"),
};

const { processOrderUpdateUnified } =
  require("./services/orderUpdate.service");

const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");

const sqs = new SQSClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const THROTTLE_MS = 50;

let isRunning = false;

async function sqsWorkerTick() {
  if (isRunning) return;
  isRunning = true;

  try {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 120,
      })
    );

    if (!res.Messages?.length) return;

    for (const msg of res.Messages) {
      try {
        const job = JSON.parse(msg.Body);

        await processOrderUpdateUnified({
          payload: job.payload,
          shop: job.shop,
          mode: "FULL",
          Services, // ✅ REQUIRED
        });

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle,
          })
        );

        await new Promise(r => setTimeout(r, THROTTLE_MS));
      } catch (err) {
        console.error("❌ Worker job failed (retrying):", err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

console.log("✅ ORDERS_UPDATED worker started");

setInterval(sqsWorkerTick, 1000);
