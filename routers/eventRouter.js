const eventsRouter = require("express").Router();
const venueRouter = require("./eventsRoutes/venueRouter");
const paymentsRouter = require("./eventsRoutes/paymentsAndDiscounts");
const datesRouter = require("./eventsRoutes/dateRouter");
const waitlistRouter = require("./eventsRoutes/waitListRouter");

eventsRouter.use("/venue", venueRouter);
eventsRouter.use("/payments", paymentsRouter);
eventsRouter.use("/dates", datesRouter);
eventsRouter.use("/waitlists", waitlistRouter);

module.exports = eventsRouter;
