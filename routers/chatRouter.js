// routers/chatRouter.js

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyJWT = require("../middlewares/verifyJWT");
const { Channel } = require("../models/chatModels");
const chatRouter = express.Router();

const channeLRouter = require("./chatRouters/channelRouter");
const chatsRouter = require("./chatRouters/chatRouter");
const readUptoRouter = require("./chatRouters/ReadUptoRouter");

chatRouter.use("/channel", channeLRouter);
chatRouter.use("/chat", chatsRouter);
chatRouter.use("/readUpto", readUptoRouter);

module.exports = chatRouter;
