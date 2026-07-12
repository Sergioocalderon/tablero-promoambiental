import asyncio
from playwright.async_api import async_playwright

URL_TABLERO = "https://tablero-promoambiental-8xb7cnvxlnu8mrbqprlf8f.streamlit.app/"

async def main():
    async with async_playwright() as p:
        navegador = await p.chromium.launch()
        pagina = await navegador.new_page()
        await pagina.goto(URL_TABLERO, wait_until="domcontentloaded", timeout=120000)
        await pagina.wait_for_timeout(5000)

        boton_despertar = pagina.get_by_role("button", name="Yes, get this app back up!")
        if await boton_despertar.count() > 0:
            print("La app estaba dormida, despertando...")
            await boton_despertar.click()
            await pagina.wait_for_timeout(60000)
        else:
            print("La app ya estaba despierta.")

        await navegador.close()

asyncio.run(main())
