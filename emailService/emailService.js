const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

module.exports = async function sendBulkEmails(batch) {
  const sendPromises = batch.map(
    ({ to, subject, description, templateName, data }) => {
      const personalizedText = templateName
        ? applyTemplate(templateName, data)
        : description;

      return transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        ...(templateName
          ? { html: personalizedText }
          : { text: personalizedText }),
      });
    }
  );
  await Promise.allSettled(sendPromises);
};

function applyTemplate(name, data) {
  if (name === "welcome") {
    return `<p>Hi ${data.name},<br><br>Welcome to our service!<br><br>Regards,<br>Team</p>`;
  } else if (name === "reminder") {
    return `<p>Dear ${data.name},<br><br>Just a reminder about ${data.event} on ${data.date}.<br><br>Best,<br>Team</p>`;
  } else if (name === "verification-code") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">🔐 Your Verification Code</h2>
        <p>Hello ${data.name || "User"},</p>
        <p>Here is your <strong>Meet and More</strong> verification code:</p>
        <div style="font-size: 24px; background: #f4f4f4; padding: 10px 20px; display: inline-block; border-radius: 6px; margin: 12px 0; font-weight: bold; letter-spacing: 2px; color: #2c3e50;">
          ${data.code}
        </div>
        <p style="font-size: 14px; color: #555;">Use this code to complete your password reset or verification. It expires in 5 minutes.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
      </div>
    `;
  } else if (name === "owner-reward") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #333;">🎉 Referral Reward Notification - Meet and More</h2>
      <p>Hello Meet and More Owner,</p>
      <p>A user has earned a referral reward. Here are the details:</p>
      <ul>
        <li><strong>Name:</strong> ${data.name}</li>
        <li><strong>Email:</strong> ${data.email}</li>
        <li><strong>Phone Number:</strong> ${data.phoneNumber}</li>
        <li><strong>Country Code:</strong> ${data.countryCode}</li>
        <li><strong>Gender:</strong> ${data.gender}</li>
        <li><strong>City:</strong> ${data.city}</li>
        <li><strong>Location:</strong> ${data.location}</li>
        <li><strong>Referral Code:</strong> ${data.code}</li>
        <li><strong>Reward Earned:</strong> ${data.currency} ${data.reward}</li>
        <li><strong>Total Usages:</strong> ${data.usageCount}</li>
      </ul>
      <hr style="margin: 20px 0;">
      <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
    </div>
  `;
  } else if (name === "refund-notification") {
    // Conditional check for event-specific refund vs. generic refund
    if (data.eventDate && data.city) {
      return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">💸 Refund Initiated - Meet and More</h2>
        <p>Hello ${data.name || "User"},</p>
        <p>We’ve processed a refund of <strong>${data.currency} ${
        data.amount
      }</strong> for the event in <strong>${data.city}</strong> on <strong>${
        data.eventDate
      }</strong>.</p>
        <p>Refund ID: <code>${data.refundId}</code></p>
        <p>Reason: We couldn’t assign you to a group due to our gender balance policy.</p>
        <p>Razorpay will usually credit the refund within 5–7 working days, depending on your bank or payment provider.</p>
        <p>Please feel free to register for our next event!</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
      `;
    } else {
      return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">💸 Refund Initiated</h2>
        <p>Hello ${data.name || "User"},</p>
        <p>We’ve processed a refund of <strong>${data.currency} ${
        data.amount
      }</strong> to your original payment method.</p>
        <p>Refund ID: <code>${data.refundId}</code></p>
        <p>Razorpay will usually credit the refund within 5–7 working days, depending on your bank or payment provider.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
      `;
    }
  } else if (name === "payment-confirmation") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">🎟️ Payment Confirmation - Meet and More</h2>
        <p>Hello ${data.name},</p>
        <p>Your payment for the event in <strong>${data.city}</strong> on <strong>${data.eventDate}</strong> has been successfully processed!</p>
        <ul>
          <li><strong>Amount Paid:</strong> ${data.currency} ${data.amount}</li>
          <li><strong>Payment ID:</strong> ${data.paymentId}</li>
        </ul>
        <p>You’ve been added to the waitlist for this event. We’ll notify you with further details soon!</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
      </div>
    `;
  } else if (name === "group-confirmation") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">🎉 Event Group Confirmation - Meet and More</h2>
        <p>Dear ${data.name},</p>
        <p>We’re excited to confirm your group for the upcoming event in <strong>${data.city}</strong> on <strong>${data.eventDate}</strong>!</p>
        <h3>Your Team Summary</h3>
        <ul>
          <li><strong>Number of Participants:</strong> ${data.teamSize}</li>
          <li><strong>Average Age:</strong> ${data.averageAge}</li>
          <li><strong>Industries:</strong> ${data.industries}</li>
          <li><strong>Gender Composition:</strong> ${data.genderComposition}</li>
        </ul>
        <p>Your group has been carefully curated to ensure a balanced and enjoyable experience. Stay tuned for venue details, which will be shared in a follow-up email.</p>
        <p>If you have any questions, feel free to reach out to our support team.</p>
        <p>Best regards,<br>The Meet and More Team</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
    `;
  } else if (name === "group-confirmation-venue") {
    const hasWaitlistId =
      data.waitlistId && typeof data.waitlistId === "string";

    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">📍 Event Group Confirmation & Venue Details - Meet and More</h2>
      
      <p>Dear ${data.name},</p>
      
      <p>Your group is all set for the event in <strong>${
        data.city
      }</strong> on <strong>${
      data.eventDate
    }</strong>! Below are the venue details:</p>
      
      <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <p><strong>Venue:</strong> ${data.venue || "TBD"}</p>
        <p><strong>Address:</strong> ${data.address || "Coming soon"}</p>
      </div>
      
      <p>Please arrive a few minutes early to settle in and meet your group.</p>
      
      <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Your Attendance QR Code</h3>
        <p>Click the button below to access your QR code for attendance at the event on ${
          data.eventDate
        }.</p>
        
        ${
          hasWaitlistId
            ? `
            <div style="margin: 20px 0;">
              <a href="https://api.meetandmore.com/api/attendance/generate-qr/${data.waitlistId}" 
                 style="display: inline-block; max-width: 200px; width: 100%; padding: 15px; 
                        background-color: #007bff; color: white; text-decoration: none; 
                        border-radius: 5px; border: 1px solid #ddd; text-align: center; 
                        font-weight: bold; font-size: 16px; transition: background-color 0.3s;">
                Take me to QR code
              </a>
            </div>
            <p style="font-size: 12px; color: #666;">
              If the button above doesn't work, 
              <a href="https://api.meetandmore.com/api/attendance/generate-qr/${data.waitlistId}" 
                 style="color: #007bff; text-decoration: none;">
                click here
              </a> to view your QR code. It is only accessible on the event day (${data.eventDate}).
            </p>
          `
            : `
            <p style="color: #d9534f;">
              Unable to provide QR code access. Please contact support at 
              <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a> 
              for assistance.
            </p>
          `
        }
      </div>
      
      <p>We're thrilled to bring you together for this unique experience. If you have any questions, contact our support team.</p>
      
      <p>Best regards,<br>The Meet and More Team</p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        Need help? Contact us at 
        <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
      </p>
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        © 2025 Meet and More. All rights reserved.
      </p>
    </div>
  `;
  } else if (name === "event-follow-up") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">🌟 How Was Your Event? - Meet and More</h2>
        <p>Dear ${data.name},</p>
        <p>We hope you had a fantastic time at the event in <strong>${data.city}</strong> on <strong>${data.eventDate}</strong>!</p>
        <p>We’d love to hear your feedback to make future events even better.</p>
        <p>If you need any support or have questions, our team is here for you.</p>
        <p>Best regards,<br>The Meet and More Team</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
    `;
  } else if (name === "no-show-refunded") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #333;">🚫 No-Show Refund Approval Request - Meet and More</h2>
      <p>Hello Admin,</p>
      <p>A no-show refund request has been submitted for approval with the following details:</p>
      <ul>
        <li><strong>User Name:</strong> ${data.userName}</li>
        <li><strong>User Email:</strong> ${data.userEmail}</li>
        <li><strong>User ID:</strong> ${data.userId}</li>
        <li><strong>Refund Amount:</strong> ${data.currency} ${data.refundAmount}</li>
        <li><strong>Payment ID:</strong> ${data.paymentId}</li>
        <li><strong>Event Date:</strong> ${data.eventDate}</li>
        <li><strong>City:</strong> ${data.city}</li>
        <li><strong>Recorded Location:</strong> Latitude ${data.latitude}, Longitude ${data.longitude}</li>
      </ul>
      <p>Please review and process the refund of ${data.currency} ${data.refundAmount} in the payment platform.</p>
      <p><strong>Location Verification:</strong> The user's attendance location has been recorded and can be verified against the event venue.</p>
      
      <!-- Action Links (Email-client compatible) -->
      <div style="margin: 30px 0; text-align: center;">
        <a 
          href="https://www.google.com/maps?q=${data.latitude},${data.longitude}&z=15" 
          target="_blank"
          style="background-color: #10b981; color: white; text-decoration: none; padding: 12px 24px; margin: 5px; border-radius: 6px; display: inline-block; font-size: 14px; font-weight: 500;"
        >
          📍 View Location on Map
        </a>
        
        <a 
          href="https://api.meetandmore.com/api/payments/refund/noshow/${data.paymentId}" 
          target="_blank"
          style="background-color: #3b82f6; color: white; text-decoration: none; padding: 12px 24px; margin: 5px; border-radius: 6px; display: inline-block; font-size: 14px; font-weight: 500;"
        >
          💳 Mark as Refund
        </a>
      </div>
      
      <!-- Quick Copy Section -->
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0;">
        <p style="margin: 0 0 10px 0; font-weight: bold; color: #495057;">Quick Actions:</p>
        <p style="margin: 5px 0; font-size: 12px; color: #6c757d;">
          <strong>Maps URL:</strong> 
          <span style="background-color: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace;">
            https://www.google.com/maps?q=${data.latitude},${data.longitude}&z=15
          </span>
        </p>
        <p style="margin: 5px 0; font-size: 12px; color: #6c757d;">
          <strong>API Endpoint:</strong> 
          <span style="background-color: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace;">
            GET https://api.meetandmore.com/api/payments/refund/noshow/${data.paymentId}
          </span>
        </p>
        <p style="margin: 5px 0; font-size: 12px; color: #6c757d;">
          <strong>Payment ID:</strong> 
          <span style="background-color: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace;">
            ${data.paymentId}
          </span>
        </p>
      </div>
      
      <hr style="margin: 20px 0;">
      <p style="font-size: 12px; color: #999;">This is an automated notification from Meet and More.</p>
      <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
    </div>
  `;
  } else if (name === "new-team-member") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">🔔 New Team Member Added - Meet and More</h2>
        <p>Dear ${data.name},</p>
        <p>A new member has joined your group for the event in <strong>${data.city}</strong> on <strong>${data.eventDate}</strong>!</p>
        <p>The updated team size is now <strong>${data.teamSize}</strong>.</p>
        <p>Stay tuned for an updated group summary with more details.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
    `;
  } else if (name === "updated-group-summary") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #333;">📋 Updated Group Summary - Meet and More</h2>
        <p>Dear ${data.name},</p>
        <p>Your group for the event in <strong>${data.city}</strong> on <strong>${data.eventDate}</strong> has been updated!</p>
        <h3>Updated Team Summary</h3>
        <ul>
          <li><strong>Number of Participants:</strong> ${data.teamSize}</li>
          <li><strong>Average Age:</strong> ${data.averageAge}</li>
          <li><strong>Industries:</strong> ${data.industries}</li>
          <li><strong>Gender Composition:</strong> ${data.genderComposition}</li>
        </ul>
        <p>We’ve added a new member to your group to enhance your experience. If you have any questions, contact our support team.</p>
        <p>Best regards,<br>The Meet and More Team</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Need help? Contact us at support@meetandmore.com</p>
        <p style="font-size: 12px; color: #999;">© 2025 Meet and More. All rights reserved.</p>
      </div>
    `;
  } else if (name === "manual-refund-notification") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #d32f2f;">⚠️ Manual Refund Required</h2>
        <p>Hello Admin,</p>
        <p>A payment could not be refunded automatically and requires your attention. Please process the refund manually via the Razorpay dashboard or alternative methods.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">User ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.userId}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">User Email:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.userEmail}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Payment ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.paymentId}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Amount:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.amount} ${data.currency}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Event:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.city} on ${data.eventDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Reason:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.reason}</td>
          </tr>
        </table>
        <p style="font-size: 14px; color: #555;">Please review the payment details and take appropriate action. Contact support@meetandmore.com if you need assistance.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
      </div>
    `;
  } else if (name === "dead-letter-notification") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #d32f2f;">🚨 Dead-Letter Queue Alert</h2>
        <p>Hello Admin,</p>
        <p>A job has failed and been moved to the dead-letter queue. Please review the details below and take appropriate action to resolve the issue.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Queue Name:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              data.queueName
            }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Error Message:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.error}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Original Data:</td>
            <td style="padding: 8px; border: 1px solid #ddd;"><pre style="font-size: 12px; white-space: pre-wrap;">${
              data.originalData
            }</pre></td>
          </tr>
        </table>
        <p style="font-size: 14px; color: #555;">Please investigate the failure and retry the job if necessary. Check the DeadLetterLogs collection for additional details. Contact support@meetandmore.com for assistance.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Generated on ${new Date().toLocaleString(
          "en-US",
          { timeZone: "Asia/Kolkata" }
        )} IST</p>
        <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
      </div>
    `;
  } else if (name === "refund-failure-notification") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #d32f2f;">⚠️ Refund Processing Failure</h2>
        <p>Hello Admin,</p>
        <p>An attempt to process a refund has failed. Please review the details below and take appropriate action to resolve the issue.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">User ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              data.userId
            }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">User Email:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              data.userEmail
            }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Payment ID:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              data.paymentId
            }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Amount:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.amount} ${
      data.currency
    }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Event:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.city} on ${
      data.eventDate
    }</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Error:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${data.error}</td>
          </tr>
        </table>
        <p style="font-size: 14px; color: #555;">Please investigate the failure and process the refund manually if necessary. Contact support@meetandmore.com for assistance.</p>
        <hr style="margin: 20px 0;">
        <p style="font-size: 12px; color: #999;">Generated on ${new Date().toLocaleString(
          "en-US",
          { timeZone: "Asia/Kolkata" }
        )} IST</p>
        <p style="font-size: 12px; color: #999;">— The Meet and More Team</p>
      </div>
    `;
  } else if (name === "nudge-repeat-event") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">🎉 Meet More Amazing People!</h2>
      
      <p>Dear ${data.name},</p>
      
      <p>We loved having you at our events! Ready to meet more amazing people? Check out our latest events${
        data.referralCode
          ? ` and share your referral code <strong>${data.referralCode}</strong> for rewards!`
          : "!"
      }</p>
      
      <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Discover New Events!</h3>
        <p>Book your next event today.</p>
        <a href="https://meetandmore.com/book" style="background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; display: inline-block;">
          Explore Events
        </a>
      </div>
      
      ${
        data.referralCode
          ? `<p>Invite friends with your code <strong>${data.referralCode}</strong> for extra rewards!</p>`
          : ""
      }
      
      <p>Can’t wait to see you there!</p>
      
      <p>Best regards,<br>The Meet and More Team</p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        Need help? Contact us at 
        <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
      </p>
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        © 2025 Meet and More. All rights reserved.
      </p>
    </div>
  `;
  } else if (name === "nudge-discount") {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">🎁 Claim Your First-Time Discount! - Meet and More</h2>
        
        <p>Dear ${data.name},</p>
        
        <p>You’ve been to an event with us before, but you haven’t claimed your first-time discount yet! Book your next event to enjoy this special offer.</p>
        
        <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Don’t Miss Out!</h3>
          <p>Book now and save on your next event!</p>
          <a href="https://meetandmore.com/book" style="background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; display: inline-block;">
            Book Now
          </a>
        </div>
        
        <p>Hurry, this offer won’t last forever!</p>
        
        <p>Best regards,<br>The Meet and More Team</p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          Need help? Contact us at 
          <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
        </p>
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          © 2025 Meet and More. All rights reserved.
        </p>
      </div>
    `;
  } else if (name === "nudge-first-event") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">🌟 Claim Your First-Time Discount!</h2>
      
      <p>Dear ${data.name},</p>
      
      <p>Your first adventure with Meet and More is waiting! Book your first event now to claim your exclusive discount${
        data.referralCode
          ? ` and share your referral code <strong>${data.referralCode}</strong> to earn rewards!`
          : "!"
      }</p>
      
      <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Start Your Journey!</h3>
        <p>Book your first event today.</p>
        <a href="https://meetandmore.com/book" style="background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; display: inline-block;">
          Book Now
        </a>
      </div>
      
      ${
        data.referralCode
          ? `<p>Invite friends with your code <strong>${data.referralCode}</strong> for extra rewards!</p>`
          : ""
      }
      
      <p>Don’t miss out!</p>
      
      <p>Best regards,<br>The Meet and More Team</p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        Need help? Contact us at 
        <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
      </p>
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        © 2025 Meet and More. All rights reserved.
      </p>
    </div>
  `;
  } else if (name === "nudge-upcoming-events") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">🎉 Discover Upcoming Events with Meet and More!</h2>
      
      <p>Dear ${data.name},</p>
      
      <p>We loved having you at our past events! Ready for more? Check out our exciting upcoming events and share your referral code <strong>${data.referralcode}</strong> to earn rewards for every friend who joins!</p>
      
      <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Join the Fun Again!</h3>
        <p>Book an upcoming event and use your referral code to save more!</p>
        <a href="https://meetandmore.com/book" style="background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; display: inline-block;">
          Explore Events
        </a>
      </div>
      
      <p>Refer friends with your code <strong>${data.referralcode}</strong> and earn rewards on each booking!</p>
      
      <p>Best regards,<br>The Meet and More Team</p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        Need help? Contact us at 
        <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
      </p>
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        © 2025 Meet and More. All rights reserved.
      </p>
    </div>
  `;
  } else if (name === "nudge-first-event-referral") {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">🌟 Start Your Journey with Meet and More!</h2>
      
      <p>Dear ${data.name},</p>
      
      <p>It’s time to book your first event with Meet and More! Connect with new people and share your referral code <strong>${data.referralcode}</strong> to earn rewards when your friends join!</p>
      
      <div style="background-color: #f0f8ff; padding: 20px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Your First Event Awaits!</h3>
        <p>Book today and kickstart your journey with us.</p>
        <a href="https://meetandmore.com/book" style="background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; display: inline-block;">
          Book Your First Event
        </a>
      </div>
      
      <p>Invite friends with your code <strong>${data.referralcode}</strong> to earn rewards!</p>
      
      <p>Best regards,<br>The Meet and More Team</p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        Need help? Contact us at 
        <a href="mailto:support@meetandmore.com" style="color: #007bff;">support@meetandmore.com</a>
      </p>
      
      <p style="font-size: 12px; color: #666; text-align: center;">
        © 2025 Meet and More. All rights reserved.
      </p>
    </div>
  `;
  }
  return "<p>Hello!</p>";
}
