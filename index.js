#!/usr/bin/env node

/**
 * Arknights: Endfield Auto Daily Check-in
 * Simple script for automated daily attendance via SKPort API
 */

import crypto from 'crypto'

const accountTokens = (process.env.ACCOUNT_TOKEN || "").split('\n').map(s => decodeURIComponent(s.trim())).filter(Boolean)
const discordWebhook = process.env.DISCORD_WEBHOOK
const discordUser = process.env.DISCORD_USER

const BINDING_URL = 'https://zonai.skport.com/api/v1/game/player/binding'
const ATTENDANCE_URL = 'https://zonai.skport.com/web/v1/game/endfield/attendance'
const GENERATE_CRED_URL = 'https://zonai.skport.com/web/v1/user/auth/generate_cred_by_code'
const OAUTH_GRANT_URL = 'https://as.gryphline.com/user/oauth2/v2/grant'
const BASIC_INFO_URL = 'https://as.gryphline.com/user/info/v1/basic'
const ENDFIELD_GAME_ID = '3'
const APP_CODE = '6eb76d4e13aa36e6'
const VNAME = '1.0.0'
const PLATFORM = '3'

const messages = []
let hasErrors = false

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function log(type, ...data) {
  console[type](...data)
  switch (type) {
    case 'debug': return
    case 'error': hasErrors = true
  }
  const string = data.map(v => typeof v === 'object' ? JSON.stringify(v, null, 2) : v).join(' ')
  messages.push({ type, string })
}

async function performOAuthFlow(accountToken) {
  if (!accountToken) throw new Error('Токен аккаунта не указан')

  const infoUrl = `${BASIC_INFO_URL}?token=${encodeURIComponent(accountToken)}`
  const infoRes = await fetch(infoUrl, { method: 'GET', headers: { 'Accept': 'application/json' } })
  const infoData = await infoRes.json()
  if (infoData.status !== 0) {
    throw new Error(`Ошибка авторизации: ${infoData.msg || JSON.stringify(infoData)}`)
  }

  const grantRes = await fetch(OAUTH_GRANT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ token: accountToken, appCode: APP_CODE, type: 0 })
  })
  const grantData = await grantRes.json()
  if (grantData.status !== 0 || !grantData.data?.code) {
    throw new Error(`Ошибка получения кода: ${grantData.msg || JSON.stringify(grantData)}`)
  }

  const credRes = await fetch(GENERATE_CRED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'platform': PLATFORM,
      'Referer': 'https://www.skport.com/',
      'Origin': 'https://www.skport.com'
    },
    body: JSON.stringify({ code: grantData.data.code, kind: 1 })
  })
  const credData = await credRes.json()
  if (credData.code !== 0 || !credData.data?.cred) {
    throw new Error(`Ошибка получения токена: ${credData.message || JSON.stringify(credData)}`)
  }

  return {
    cred: credData.data.cred,
    salt: credData.data.token,
    userId: credData.data.userId,
  }
}

function buildHeaders(cred, gameRole = null, timestamp = null) {
  const ts = timestamp || Math.floor(Date.now() / 1000).toString()
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'origin': 'https://game.skport.com',
    'referer': 'https://game.skport.com/',
    'cred': cred,
    'platform': PLATFORM,
    'sk-language': 'en',
    'timestamp': ts,
    'vname': VNAME,
    'User-Agent': 'Skport/0.7.0 (com.gryphline.skport; build:700089; Android 33; ) Okhttp/5.1.0'
  }
  if (gameRole) headers['sk-game-role'] = gameRole
  return headers
}

function computeSignV2(path, timestamp, salt) {
  if (!salt) return null
  const headerJson = JSON.stringify({ platform: PLATFORM, timestamp, dId: "", vName: VNAME })
  const s = `${path}${timestamp}${headerJson}`
  const hmac = crypto.createHmac('sha256', salt).update(s).digest('hex')
  return crypto.createHash('md5').update(hmac).digest('hex')
}

async function getPlayerRoles(cred, salt) {
  const path = '/api/v1/game/player/binding'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const headers = buildHeaders(cred, null, timestamp)

  const sign = computeSignV2(path, timestamp, salt)
  if (!sign) throw new Error('Отсутствует salt для подписи')
  headers['sign'] = sign

  const res = await fetch(BINDING_URL, { method: 'GET', headers })
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.message || `Ошибка API: ${json.code}`)

  const endfieldApp = json.data?.list?.find(app => app.appCode === 'endfield')
  if (!endfieldApp || !endfieldApp.bindingList?.length) throw new Error('Аккаунт Endfield не найден')

  const allRoles = []
  for (const binding of endfieldApp.bindingList) {
    const roles = binding.roles || []
    for (const role of roles) {
      allRoles.push({
        gameRole: `${ENDFIELD_GAME_ID}_${role.roleId}_${role.serverId}`,
        nickname: role.nickname,
        level: role.level,
        server: role.serverName,
        serverId: role.serverId,
        roleId: role.roleId,
      })
    }
  }
  if (!allRoles.length) throw new Error('Персонажи не найдены')
  return allRoles
}

async function checkAttendance(headers) {
  const res = await fetch(ATTENDANCE_URL, { method: 'GET', headers })
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.message || `Ошибка проверки чек-ина: ${json.code}`)
  return {
    hasToday: json.data?.hasToday ?? false,
    totalSignIns: json.data?.records?.length ?? 0
  }
}

async function claimAttendance(headers) {
  const res = await fetch(ATTENDANCE_URL, { method: 'POST', headers, body: null })
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.message || `Ошибка получения награды: ${json.code}`)
  const rewards = []
  const awardIds = json.data?.awardIds ?? []
  const resourceMap = json.data?.resourceInfoMap ?? {}
  for (const award of awardIds) {
    const info = resourceMap[award.id]
    if (info) rewards.push(`${info.name} x${info.count}`)
  }
  return { rewards }
}

async function checkInRole(cred, role, salt) {
  const path = '/web/v1/game/endfield/attendance'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const headers = buildHeaders(cred, role.gameRole, timestamp)

  const sign = computeSignV2(path, timestamp, salt)
  if (!sign) throw new Error('Отсутствует salt для подписи')
  headers['sign'] = sign

  const status = await checkAttendance(headers)
  if (status.hasToday) return { success: true, alreadyClaimed: true }
  const result = await claimAttendance(headers)
  return { success: true, alreadyClaimed: false, rewards: result.rewards }
}

async function runAccount(accountToken, accountIndex) {
  log('debug', `\n----- АККАУНТ ${accountIndex} -----`)
  try {
    const oauth = await performOAuthFlow(accountToken)
    const { cred, salt } = oauth
    log('debug', `Аккаунт ${accountIndex}: токен получен`)

    const roles = await getPlayerRoles(cred, salt)
    log('debug', `Аккаунт ${accountIndex}: найдено персонажей ${roles.length}`)

    for (const role of roles) {
      const roleLabel = `${role.nickname} (Ур.${role.level}) [${role.server}]`
      try {
        const result = await checkInRole(cred, role, salt)
        if (result.alreadyClaimed) {
          log('info', `Endfield: Уже отмечен сегодня`)
        } else if (result.rewards?.length > 0) {
          log('info', `Endfield: Отмечен! Награды: ${result.rewards.join(', ')}`)
        } else {
          log('info', `Endfield: Успешно отмечен!`)
        }
      } catch (err) {
        log('error', `${roleLabel}:`, err.message)
      }
      await sleep(500)
    }
  } catch (err) {
    log('error', `Аккаунт ${accountIndex}:`, err.message)
  }
}

async function discordWebhookSend() {
  log('debug', '\n----- DISCORD WEBHOOK -----')
  if (!discordWebhook || !discordWebhook.toLowerCase().trim().startsWith('https://discord.com/api/webhooks/')) {
    log('debug', 'DISCORD_WEBHOOK не настроен, пропускаем')
    return
  }
  let discordMsg = ''
  if (discordUser) discordMsg = `<@${discordUser}>\n`
  discordMsg += messages.map(msg => `${msg.string}`).join('\n')
  const res = await fetch(discordWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: discordMsg })
  })
  if (res.status === 204) { log('debug', 'Сообщение отправлено в Discord'); return }
  log('error', 'Ошибка отправки в Discord')
}

// Main
if (!accountTokens || accountTokens.length === 0) {
  throw new Error('Переменная ACCOUNT_TOKEN не задана')
}

for (let i = 0; i < accountTokens.length; i++) {
  await runAccount(accountTokens[i], i + 1)
  if (i < accountTokens.length - 1) await sleep(1000)
}

if (discordWebhook) {
  await discordWebhookSend()
}

if (hasErrors) {
  console.log('')
  throw new Error('Произошли ошибки.')
}
