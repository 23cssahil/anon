# Security Guidelines 🔐

## Fixed Issues

### 1. ✅ Authentication & Authorization
- **Issue**: No auth mechanism, any userId accessible
- **Fix**: JWT token-based authentication on all protected routes
- **Implementation**: `authenticateToken` middleware validates tokens
- **Check**: `/api/balance/:userId` now requires valid token and user must own the resource

### 2. ✅ Rate Limiting
- **Issue**: No rate limit, vulnerable to DDoS and brute force
- **Fix**: Express rate limiter configured for each endpoint
  - Login: 10 requests per 15 minutes
  - OTP: 5 requests per 5 minutes
  - Calls: 30 requests per 1 minute
  - Recharge: 20 requests per 1 hour

### 3. ✅ Input Validation
- **Issue**: No phone number format validation
- **Fix**: Regex validation for Indian phone numbers
  - Must start with 6-9
  - Exactly 10 digits
  - Example: `9876543210` ✓

### 4. ✅ Data Encryption
- **Issue**: Sensitive phone numbers stored in plain text
- **Fix**: AES-256 encryption for phone numbers
- **Function**: `encryptSensitiveData()` / `decryptSensitiveData()`

### 5. ✅ OTP Security
- **Issue**: Weak 4-digit OTP easily guessable
- **Fix**: 6-digit OTP (1 million combinations)
- **Expiry**: 5 minutes

### 6. ✅ Error Handling
- **Issue**: Generic error messages, console.log exposing OTP
- **Fix**: Proper error messages without sensitive info
- **Logging**: Development mode only logs for debugging

### 7. ✅ Database Performance
- **Issue**: No indexes on frequently queried fields
- **Fix**: Added indexes on:
  - `userId`, `date` (call history queries)
  - `googleId`, `email` (user lookups)
  - `createdAt` (sorting)

### 8. ✅ Environment Variables
- **Issue**: No validation of required env vars
- **Fix**: Process exits if MONGO_URI not set
- **Best Practice**: .env.example provided with all required vars

## Production Checklist

Before deploying to production:

- [ ] Change `JWT_SECRET` to a strong random string (minimum 32 characters)
- [ ] Change `ENCRYPTION_KEY` to a strong random string (minimum 32 characters)
- [ ] Set `NODE_ENV=production`
- [ ] Integrate with real payment gateway (Razorpay/PayU)
- [ ] Integrate with SMS provider (Twilio/AWS SNS)
- [ ] Enable HTTPS/TLS on server
- [ ] Setup MongoDB with strong authentication
- [ ] Configure firewall rules
- [ ] Setup monitoring & logging (Sentry, LogRocket)
- [ ] Enable database backups
- [ ] Implement CSRF protection
- [ ] Setup rate limiting at reverse proxy level
- [ ] Add request logging middleware
- [ ] Test all error scenarios
- [ ] Security audit by third party

## Security Best Practices Implemented

### 1. **Principle of Least Privilege**
```javascript
// Users can only access their own data
if (req.user.userId !== req.params.userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized access' });
}
```

### 2. **Input Sanitization**
```javascript
function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input.trim().replace(/[<>]/g, '');
}
```

### 3. **Encryption at Rest**
```javascript
function encryptSensitiveData(data) {
    // AES-256-CBC encryption
    const algorithm = 'aes-256-cbc';
    // ... encryption logic
}
```

### 4. **Error Boundaries**
```javascript
try-catch blocks wrap all async operations
Generic error messages to users
Detailed logging for debugging (dev only)
```

### 5. **Token Expiry**
```javascript
jwt.sign(payload, secret, { expiresIn: '7d' })
// Tokens expire after 7 days
```

## Known Limitations & Next Steps

### Payment Processing ⚠️
Currently `POST /api/add-recharge` accepts amounts directly without payment verification.
**TODO**: 
1. Create payment order on Razorpay/PayU
2. Redirect to payment page
3. Verify webhook signature
4. Credit balance only after verification

### OTP Delivery ⚠️
Currently OTP only logged to console in development.
**TODO**:
1. Integrate Twilio/AWS SNS
2. Send actual SMS
3. Add delivery tracking

### Session Management 🚀
Consider implementing:
- Refresh token rotation
- Token blacklist for logout
- Session-based rate limiting

### Database Security 🔐
- Enable MongoDB encryption at rest
- Setup IP whitelist
- Regular backups

## Reporting Security Issues

If you find a security vulnerability, please email security@example.com instead of opening a public issue.

---

**Last Updated**: September 2, 2026
