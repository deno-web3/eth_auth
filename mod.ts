import { Application, Session, Router, generateNonce, SiweMessage, ErrorTypes, JsonRpcProvider } from './deps.ts'

const PORT = 3000
const app = new Application()
const router = new Router<{ session: Session }>()

app.use(Session.initMiddleware())

router.get('/api/nonce', async (ctx) => {
  await ctx.state.session.set('nonce', generateNonce())
  ctx.response.status = 200
  ctx.response.body = (await ctx.state.session.get('nonce')) as string
})

router.get('/api/me', async (ctx) => {
  const session = ctx.state.session
  if (!(await session.get('siwe'))) {
    ctx.response.status = 401
    ctx.response.headers.set('Content-Type', 'application/json')
    ctx.response.body = { message: 'You have to first sign_in' }
    return
  }

  ctx.response.status = 200
  ctx.response.body = {
    address: ((await session.get('siwe')) as InstanceType<typeof SiweMessage>).address,
    ens: await session.get('ens')
  }
})

const getInfuraUrl = (chainId: string) => {
  switch (Number.parseInt(chainId)) {
    case 1:
      return 'https://mainnet.infura.io/v3'
    case 3:
      return 'https://ropsten.infura.io/v3'
    case 4:
      return 'https://rinkeby.infura.io/v3'
    case 5:
      return 'https://goerli.infura.io/v3'
    case 137:
      return 'https://polygon-mainnet.infura.io/v3'
  }
}

router.post('/api/sign_in', async (ctx) => {
  try {
    const body = await ctx.request.body().value
    const { ens } = body
    if (!body.message) {
      ctx.response.status = 422
      ctx.response.body = { message: 'Expected signMessage object as body.' }

      return
    }

    const message = new SiweMessage(body.message)

    const infuraProvider = new JsonRpcProvider(
      {
        allowGzip: true,
        url: `${getInfuraUrl(message.chainId)}/8fcacee838e04f31b6ec145eb98879c8`,
        headers: {
          Accept: '*/*',
          Origin: `http://localhost:${PORT}`,
          'Accept-Encoding': 'gzip, deflate, br',
          'Content-Type': 'application/json'
        }
      },
      Number.parseInt(message.chainId)
    )

    await infuraProvider.ready

    const fields = await message.validate(infuraProvider)

    if (fields.nonce !== (await ctx.state.session.get('nonce'))) {
      ctx.response.status = 422
      ctx.response.body = {
        message: `Invalid nonce.`
      }

      return
    }

    await ctx.state.session.set('siwe', fields)
    await ctx.state.session.set('ens', ens)
    await ctx.state.session.set('nonce', null)
    if (fields.expirationTime) await ctx.state.session.set('expires', new Date(fields.expirationTime))

    ctx.response.status = 200
    ctx.response.body = {
      address: fields.address,
      ens
    }
  } catch (e) {
    await ctx.state.session.set('siwe', null)
    await ctx.state.session.set('ens', null)
    await ctx.state.session.set('nonce', null)
    console.error(e)
    switch (e) {
      case ErrorTypes.EXPIRED_MESSAGE: {
        ctx.response.status = 440
        ctx.response.body = { message: e.message }
        break
      }
      case ErrorTypes.INVALID_SIGNATURE: {
        ctx.response.status = 422
        ctx.response.body = { message: e.message }
        break
      }
      default: {
        ctx.response.status = 500
        ctx.response.body = { message: e.message }
        break
      }
    }
  }
})

router.post('/api/sign_out', async (ctx) => {
  const session = ctx.state.session
  if (!(await session.get('siwe'))) {
    ctx.response.status = 401
    ctx.response.headers.set('Content-Type', 'application/json')
    ctx.response.body = { message: 'You have to first sign_in' }
    return
  }
  ctx.response.status = 205
  ctx.response.body = ''
})

app.use(router.routes())
app.use(router.allowedMethods())

await app.listen(`:3000`)
