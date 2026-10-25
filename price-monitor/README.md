# Prisbevakning: Roborock Qrevo Master / Qrevo MaxV

Kollar lägsta pris två gånger om dagen och sparar historiken i `history.json`.

```
node price-monitor/check-prices.js            # kolla och spara
node price-monitor/check-prices.js --no-save  # bara kolla
```

Källor:

| Källa | Status |
|---|---|
| PriceRunner | läses (täcker CDON, Avengo, Buyn m.fl.) |
| Roborock SE | läses, med lagerstatus (larmar när en slutsåld vara finns i lager igen) |
| NetOnNet, Power, Webhallen | läses direkt |
| Elgiganten, Proshop, Amazon.se | blockerar ofta automatiska besök, så de bevakas via websökning efter kampanjer |

Lägsta pris räknas bara på nya varor i lager. Fyndvara/begagnat visas separat.
Kräver Node och Playwright (Chromium).
