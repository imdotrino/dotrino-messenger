/**
 * Sanitize user input to prevent XSS attacks
 * Escapes HTML special characters
 */
export function sanitize(input) {
  if (!input || typeof input !== 'string') {
    return ''
  }

  const div = document.createElement('div')
  div.textContent = input
  return div.innerHTML
}

/**
 * Validate and sanitize a nickname
 */
export function sanitizeNickname(nick) {
  if (!nick || typeof nick !== 'string') {
    return ''
  }

  // Remove any HTML, trim whitespace
  const sanitized = sanitize(nick).trim()

  // Remove any remaining suspicious characters
  return sanitized.replace(/[<>"'`]/g, '')
}

/**
 * Validate and sanitize message text
 */
export function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  // Escape HTML entities
  const sanitized = sanitize(text)

  // Trim and limit length
  return sanitized.trim().slice(0, 1000)
}
