const mongoose = require("mongoose");

const deadLetterLogSchema = new mongoose.Schema({
  _id: { type: String, default: require("uuid").v4 },
  queueName: { type: String, required: true }, // e.g., failed-refund, failed-email
  originalData: { type: Object, required: true },
  error: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const DeadLetterLogs = mongoose.model("DeadLetterLogs", deadLetterLogSchema);
module.exports = DeadLetterLogs;
