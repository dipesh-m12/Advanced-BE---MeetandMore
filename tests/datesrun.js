const { getBookingEventDate } = require("./dates");

// New Delhi (Asia/Kolkata), 11:00 AM IST, June 7, 2025 (Saturday)
const utcTime1 = new Date("2025-06-07T05:30:00Z"); // 11:00 AM IST
console.log(getBookingEventDate("Asia/Kolkata", utcTime1));
// Output: "2025-06-07T20:00:00.000+05:30" (June 7, 8 PM IST)

// New Delhi, 2:00 PM IST, June 7, 2025 (past noon)
const utcTime2 = new Date("2025-06-07T08:30:00Z"); // 2:00 PM IST
console.log(getBookingEventDate("Asia/Kolkata", utcTime2));
// Output: "2025-06-14T20:00:00.000+05:30" (June 14, 8 PM IST)

// New York (America/New_York), 10:00 AM EDT, June 7, 2025
const utcTime3 = new Date("2025-06-07T14:00:00Z"); // 10:00 AM EDT
console.log(getBookingEventDate("America/New_York", utcTime3));
// Output: "2025-06-07T20:00:00.000-04:00" (June 7, 8 PM EDT)
