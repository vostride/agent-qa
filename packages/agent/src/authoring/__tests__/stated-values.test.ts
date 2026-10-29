// Model-free, with false-refusal controls; imported per cell so a missing module fails each row.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

async function load() {
  return await import('../stated-values.js')
}

const HISTORICAL_REQUEST = 'open the products page and check it says "Kitchen Appliances"'

describe('quoted values, numbers, prices and dates are stated values', () => {
  it('a double-quoted string is one stated value, kept as typed', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check it says "Kitchen Appliances"')).toEqual([
      'Kitchen Appliances',
    ])
  })

  it('curly double quotes and word-bounded single quotes delimit a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check it says “Sale”')).toEqual(['Sale'])
    expect(extractStatedValues("check it says 'Sale'")).toEqual(['Sale'])
  })

  it('an apostrophe inside a word opens no quote', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues("check the user's cart and don't skip it")).toEqual([])
  })

  it('numbers, prices, percentages and numeric dates are one value each', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('add 2 items at $1,299.00 with 15% off on 2026-10-12 or 12/10/2026'),
    ).toEqual(['2', '$1,299.00', '15%', '2026-10-12', '12/10/2026'])
  })

  it('a month-name date is one value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('book it for October 12, 2026')).toEqual(['October 12, 2026'])
    expect(extractStatedValues('book it for 12 October 2026')).toEqual(['12 October 2026'])
  })

  it('a digit glued to a letter is not a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('sign in with 2FA, check the h1 on the 3rd tab and open build 1.5a'),
    ).toEqual([])
  })

  it('a number in a URL or a host and port is not a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('write a test for http://localhost:3000')).toEqual([])
    expect(extractStatedValues('open localhost:3000/products')).toEqual([])
    expect(extractStatedValues('at 10:30')).toEqual(['10:30'])
  })

  it('a number inside a quoted value is not listed again', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check it says "Total: $20"')).toEqual(['Total: $20'])
  })

  it('a value stated twice is listed once, in order of first appearance', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('"A" then 2 then "A"')).toEqual(['A', '2'])
    expect(extractStatedValues('"A""B"')).toEqual(['A', 'B'])
  })

  it('an empty or unclosed quote states nothing', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check it says ""')).toEqual([])
    expect(extractStatedValues('check it says "Kitchen Appliances')).toEqual([])
  })

  it('whitespace runs inside a quoted value are tidied', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('"Kitchen   Appliances"')).toEqual(['Kitchen Appliances'])
  })

  it('a value present word for word in a step is carried', async () => {
    const { missingStatedValues } = await load()
    expect(
      missingStatedValues(
        ['Kitchen Appliances'],
        ['Open the products page', 'Verify the products page says "Kitchen Appliances"'],
      ),
    ).toEqual([])
  })

  it('the historical substitution loses its value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const steps = [
      'Open the Automation Exercise home page',
      'Click the " products" link',
      'Verify the products page says "All Products"',
    ]
    expect(missingStatedValues(extractStatedValues(HISTORICAL_REQUEST), steps)).toEqual([
      'Kitchen Appliances',
    ])
  })

  it('a case change is missing', async () => {
    const { missingStatedValues } = await load()
    expect(
      missingStatedValues(['Kitchen Appliances'], ['Verify the heading says "Kitchen appliances"']),
    ).toEqual(['Kitchen Appliances'])
  })

  it('a singular, plural or trimmed value is missing', async () => {
    const { missingStatedValues } = await load()
    expect(
      missingStatedValues(['Kitchen Appliance'], ['Verify "Kitchen Appliances" is shown']),
    ).toEqual(['Kitchen Appliance'])
    expect(
      missingStatedValues(['Kitchen Appliances'], ['Verify "Kitchen Appliance" is shown']),
    ).toEqual(['Kitchen Appliances'])
    expect(missingStatedValues(['Kitchen Appliances'], ['Verify "Kitchen" is shown'])).toEqual([
      'Kitchen Appliances',
    ])
    expect(missingStatedValues(['Sale'], ['Verify the Wholesale banner is shown'])).toEqual([
      'Sale',
    ])
  })

  it('a number is missing inside a longer number', async () => {
    const { missingStatedValues } = await load()
    expect(missingStatedValues(['1'], ['Set the quantity to 1.5'])).toEqual(['1'])
    expect(missingStatedValues(['1'], ['Set the quantity to 10'])).toEqual(['1'])
    expect(missingStatedValues(['5'], ['Set the quantity to 1.5'])).toEqual(['5'])
    expect(missingStatedValues(['$20'], ['Verify the total says $20.00'])).toEqual(['$20'])
    expect(missingStatedValues(['50'], ['Verify the discount says 50%'])).toEqual([])
  })

  it('whitespace and canonical Unicode are tidied, compatibility forms are not', async () => {
    const { missingStatedValues } = await load()
    expect(
      missingStatedValues(
        ['Kitchen Appliances'],
        ['Verify the heading says "Kitchen  Appliances"'],
      ),
    ).toEqual([])
    expect(missingStatedValues(['Café'], ['Open the Café menu'])).toEqual([])
    expect(missingStatedValues(['12'], ['Set the quantity to １２'])).toEqual(['12'])
  })

  it('numbers are compared as text', async () => {
    const { missingStatedValues } = await load()
    expect(missingStatedValues(['1.50'], ['Verify the price is 1.5'])).toEqual(['1.50'])
    expect(missingStatedValues(['$1,299.00'], ['Verify the price is $1299'])).toEqual(['$1,299.00'])
    expect(missingStatedValues(['2026-10-12'], ['Verify the date is 12/10/2026'])).toEqual([
      '2026-10-12',
    ])
  })

  it('only steps are searched', async () => {
    const { missingStatedValues } = await load()
    const draft = {
      testName: 'Confirm the Sale banner',
      context: 'The home page shows a "Sale" banner',
      target: 'Sale',
      steps: ['Open the home page', 'Verify the banner is shown'],
    }
    expect(missingStatedValues(['Sale'], draft.steps)).toEqual(['Sale'])
    expect(
      missingStatedValues(['Kitchen Appliances'], ['Verify Kitchen', 'Appliances is shown']),
    ).toEqual(['Kitchen Appliances'])
  })

  it("missing values keep the request's order", async () => {
    const { missingStatedValues, statedValuesMissingReason } = await load()
    expect(
      missingStatedValues(['Sale', '$20', 'Kitchen Appliances'], ['Verify the "Sale" banner']),
    ).toEqual(['$20', 'Kitchen Appliances'])
    expect(statedValuesMissingReason(['$20'])).toBe(
      'the request\'s stated values are missing: "$20"',
    )
  })

  it('a long adversarial request is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const digits = `${'1.'.repeat(99_999)}1a`
    const quotes = "“a 'b ".repeat(40_000).slice(0, 200_000)
    expect(digits).toHaveLength(200_000)
    expect(quotes).toHaveLength(200_000)

    for (const request of [digits, quotes]) {
      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1', '1.1', 'a', 'b'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })

  it('the module is pure', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../stated-values.ts', import.meta.url)),
      'utf8',
    )
    expect(source).not.toMatch(/^(import|export \* from)/m)
    expect(source).not.toMatch(/^(let|var) /m)
  })
})

describe('reworded and added draft text is kept', () => {
  it('reworded unquoted words are kept', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(
      missingStatedValues(extractStatedValues(HISTORICAL_REQUEST), [
        'Navigate to the catalogue',
        'Confirm the heading reads "Kitchen Appliances"',
      ]),
    ).toEqual([])
  })

  it('added steps and added checks are kept', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(
      missingStatedValues(extractStatedValues(HISTORICAL_REQUEST), [
        'Sign in as the "shopper" user',
        'Open the products page',
        'Verify the products page says "Kitchen Appliances"',
        'Verify at least one product card is shown',
      ]),
    ).toEqual([])
  })

  it('a vague request is kept whatever the draft says', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues('test the products page')
    expect(values).toEqual([])
    expect(
      missingStatedValues(values, ['Open the home page', 'Verify "All Products" is shown']),
    ).toEqual([])
    expect(missingStatedValues([], [])).toEqual([])
  })

  it('a value inside a longer step phrase is kept', async () => {
    const { missingStatedValues } = await load()
    expect(
      missingStatedValues(
        ['Kitchen Appliances'],
        ['Verify the banner says "Kitchen Appliances Sale"'],
      ),
    ).toEqual([])
  })
})

// List markers are not stated values.
describe('list and step numbers are not stated values', () => {
  it('a numbered list written inline states no list number', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues(
      '1. open the shop 2. click the "Add to cart" button 3. check the cart',
    )
    expect(values).toEqual(['Add to cart'])
    expect(
      missingStatedValues(values, [
        'Open the shop',
        'Click the "Add to cart" button',
        'Verify the cart is shown',
      ]),
    ).toEqual([])
  })

  it('a numbered list written one item per line states no list number', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues(
        '1. open the products page\n2. click the first product\n3. check the "Add to cart" button is shown',
      ),
    ).toEqual(['Add to cart'])
    expect(extractStatedValues('1. open the shop\r\n2. add 3 items\r\n3. check the cart')).toEqual([
      '3',
    ])
    expect(extractStatedValues('Test checkout\n1. open the shop\n2. add 2 items')).toEqual(['2'])
  })

  it('a list numbered with closing parentheses states no list number', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('1) open the shop 2) add 2 items 3) check the total is $20'),
    ).toEqual(['2', '$20'])
    expect(
      extractStatedValues('1) open the shop\n2) add 2 items\n3) check the total is $20'),
    ).toEqual(['2', '$20'])
  })

  it('a list numbered in parentheses states no list number', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues(
      '(1) open the shop (2) click the "Add to cart" button (3) check the cart',
    )
    expect(values).toEqual(['Add to cart'])
    expect(
      missingStatedValues(values, [
        'Open the shop',
        'Click the "Add to cart" button',
        'Verify the cart is shown',
      ]),
    ).toEqual([])
    expect(
      extractStatedValues('(1) open the shop\n(2) add 2 items\n(3) check the total is $20'),
    ).toEqual(['2', '$20'])
    expect(extractStatedValues('Checkout test: (1) open the shop (2) add 2 items')).toEqual(['2'])
  })

  it('a numbered list after a colon or a sentence states no list number', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('Checkout test: 1. open the shop 2. add 2 items 3. check "Add to cart"'),
    ).toEqual(['2', 'Add to cart'])
    expect(extractStatedValues('Test the cart. 1. add 2 items 2. check the total is $20')).toEqual([
      '2',
      '$20',
    ])
  })

  it('a step-labelled request states no step number', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues(
        'Step 1: open the products page. Step 2: check the heading says "All Products"',
      ),
    ).toEqual(['All Products'])
    expect(extractStatedValues('Step 1 - open the shop Step 2 - add 2 items')).toEqual(['2'])
    expect(extractStatedValues('step 1 – open the shop step 2 — add 2 items')).toEqual(['2'])
    expect(extractStatedValues('Step 1) open the shop. Step 2. add 2 items')).toEqual(['2'])
  })
})

describe('stated values inside lists', () => {
  it('a number, price or quoted value inside a list item is still a stated value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues('1. open the shop 2. add 2 items 3. check the total is $20')
    expect(values).toEqual(['2', '$20'])
    expect(
      missingStatedValues(values, [
        'Open the shop',
        'Add items to the cart',
        'Verify the total is shown',
      ]),
    ).toEqual(['2', '$20'])
    expect(
      missingStatedValues(extractStatedValues('1. open the shop 2. click "Add to cart"'), [
        'Open the shop',
        'Click the cart button',
      ]),
    ).toEqual(['Add to cart'])
  })

  it('a list marker inside a quoted value is kept as typed', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('1. check the heading says "Step 1: Cart" 2. click "2. Next"'),
    ).toEqual(['Step 1: Cart', '2. Next'])
    expect(extractStatedValues('(1) check the heading says "(2) Payment"')).toEqual(['(2) Payment'])
  })

  it('a list starts only at 1, at the start of the request, a line, a colon or a sentence', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('3. open the shop 4. click the cart')).toEqual(['3', '4'])
    expect(extractStatedValues('1 open the shop 2 click the cart')).toEqual(['1', '2'])
    expect(extractStatedValues('set the quantity to 2. Then check the cart')).toEqual(['2'])
    expect(extractStatedValues('Set the quantity to 1. Then set it to 2. Check the cart')).toEqual([
      '1',
      '2',
    ])
    expect(extractStatedValues('1. set the quantity to 3. 2. check the cart shows 3')).toEqual([
      '3',
    ])
    expect(extractStatedValues('(3) open the shop (4) click the cart')).toEqual(['3', '4'])
    expect(extractStatedValues('check the cart shows (1) item')).toEqual(['1'])
    expect(extractStatedValues('(1) open the shop (2) check the total (3000) is shown')).toEqual([
      '3000',
    ])
    expect(extractStatedValues('1. open the shop (2) add 3 items')).toEqual(['2', '3'])
  })

  it('a number written where the next list marker would go is read as that marker, the known leftover', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues('1. set the quantity to 2. Then check the cart')
    expect(values).toEqual([])
    expect(missingStatedValues(values, ['Set the quantity', 'Verify the cart is shown'])).toEqual(
      [],
    )
    expect(extractStatedValues('(1) set the quantity to (2) then check the cart')).toEqual([])
    expect(extractStatedValues('1. set the quantity to 2, then check the cart')).toEqual(['2'])
    expect(extractStatedValues('1. set the quantity to 2) then check the cart')).toEqual(['2'])
    expect(extractStatedValues('1. open the shop and set the quantity to 2.')).toEqual(['2'])
  })

  it('a step number with no label delimiter is a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check step 2 of the wizard is shown')).toEqual(['2'])
    expect(extractStatedValues('check Step 2 of 3 is shown')).toEqual(['2', '3'])
    expect(extractStatedValues('check Step 1.5: the label')).toEqual(['1.5'])
    expect(extractStatedValues('check the heading says "Step 2: Payment"')).toEqual([
      'Step 2: Payment',
    ])
  })

  it('a long run of list markers and step labels is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    for (const unit of ['1. 2. 3. ', 'Step 1: ', '\n1.\n', '1) a ', '(1) (2) (3) ']) {
      const request = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

// Inch marks, in-word apostrophes and addresses state nothing.
describe('inch marks, apostrophes and addresses state nothing', () => {
  it('an inch mark opens no quoted value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues('check the 15" laptop and the 13" laptop are listed')
    expect(values).toEqual(['15', '13'])
    expect(
      missingStatedValues(values, ['Verify the 15-inch and the 13-inch laptops are listed']),
    ).toEqual([])
  })

  it('an in-word apostrophe opens no quoted value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues("check the '90s collection shows the 'Sale' banner")).toEqual([
      'Sale',
    ])
    expect(extractStatedValues("check the '90s collection and the users' cart")).toEqual([])
    const values = extractStatedValues('check the rock \'n\' roll page says "Top Hits"')
    expect(values).toEqual(['Top Hits'])
    expect(missingStatedValues(values, ['Verify the rock and roll page says "Top Hits"'])).toEqual(
      [],
    )
  })

  it('an IP address, with or without a port and path, states nothing', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('open 192.168.1.10 and check it')).toEqual([])
    expect(extractStatedValues('go to 127.0.0.1:3000/products and check 3 items')).toEqual(['3'])
    expect(extractStatedValues('open 192.168.1.10. Then check 4 items')).toEqual(['4'])
  })

  it('a bracketed IPv6 host and port states nothing', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('open the site at [::1]:3000 and check it')).toEqual([])
    expect(extractStatedValues('open [::1]:3000/cart and check 2 items')).toEqual(['2'])
  })

  it('a host and port in parentheses states nothing', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('open the app (localhost:3000) and check 2 items')).toEqual(['2'])
    expect(extractStatedValues('open the app (127.0.0.1:3000) and check 2 items')).toEqual(['2'])
  })
})

describe('quoted values beside inch marks and address-shaped numbers', () => {
  it('a quoted value next to an inch mark stays protected', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const values = extractStatedValues('check the 15" laptop shows "In Stock"')
    expect(values).toEqual(['15', 'In Stock'])
    expect(missingStatedValues(values, ['Verify the 15-inch laptop shows "Out of Stock"'])).toEqual(
      ['In Stock'],
    )
    expect(extractStatedValues('check the 5\'10" model and the "Sale" banner')).toEqual([
      '5',
      '10',
      'Sale',
    ])
  })

  it('a straight double quote opens after anything but a letter or number', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('check it says:"Sale"')).toEqual(['Sale'])
    expect(extractStatedValues('check it says ("Sale")')).toEqual(['Sale'])
  })

  it('a single-quoted value that starts with a number or is one capital letter is still a value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues("check the '2024 Sale' banner")).toEqual(['2024 Sale'])
    expect(extractStatedValues("check the '20% off' badge")).toEqual(['20% off'])
    expect(extractStatedValues("check size 'M' is selected")).toEqual(['M'])
  })

  it('a number shaped like part of an address is still a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('book it (10:30) for 2 people')).toEqual(['10:30', '2'])
    expect(extractStatedValues('check the 16:9 player')).toEqual(['16:9'])
    expect(extractStatedValues('check version 1.2.3 is shown')).toEqual(['1.2.3'])
    expect(extractStatedValues('check the date 12.10.2026')).toEqual(['12.10.2026'])
    expect(extractStatedValues('check footnote [2] and (3000)')).toEqual(['2', '3000'])
  })

  it('a long request of inch marks, apostrophes and addresses is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const units = ['15" ', "a 'n' ", '[::1]:', '(127.0.0.1:3000 ', "'1a "]
    const requests = units.map((unit) =>
      unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000),
    )
    requests.push(`'${'1'.repeat(199_998)}a`)
    for (const request of requests) {
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

// A digit-led quoted value and a bracketed time are stated values.
describe('digit-led quotes, decade elisions and bracketed times', () => {
  it('a single-quoted value that starts with digits glued to a letter is a stated value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(
      extractStatedValues("search for '4K' and check the first result title says '3D Movies'"),
    ).toEqual(['4K', '3D Movies'])
    expect(extractStatedValues("check the '4K' badge and the '2FA' toggle")).toEqual(['4K', '2FA'])
    expect(extractStatedValues("check the '1st Place' ribbon")).toEqual(['1st Place'])
    expect(extractStatedValues('check the ‘5G Plans’ tab')).toEqual(['5G Plans'])
    expect(
      missingStatedValues(extractStatedValues("check the '4K' badge"), [
        "Verify the '8K' badge is shown",
      ]),
    ).toEqual(['4K'])
  })

  it('only a two-digit decade after a single quote opens no quoted value, and a quoted value that starts with one is the known leftover', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues("check the '80s and the '70s collections")).toEqual([])
    expect(extractStatedValues("check the '90s' playlist")).toEqual(['90s'])
    expect(extractStatedValues("check the '95s' label")).toEqual(['95s'])
    expect(extractStatedValues("check the '15s timeout' label")).toEqual(['15s timeout'])
    const leftover = extractStatedValues("check the '30s ad' banner")
    expect(leftover).toEqual([])
    expect(missingStatedValues(leftover, ["Verify the '40s ad' banner is shown"])).toEqual([])
  })

  it('a bracketed time or ratio is a stated value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues('check the aspect ratio shows [16:9]')).toEqual(['16:9'])
    expect(extractStatedValues('check the slot [10:30] is shown')).toEqual(['10:30'])
    expect(extractStatedValues('check the room [Bed:2] is listed')).toEqual(['2'])
    expect(extractStatedValues('check the timer shows [10:30:45]')).toEqual(['10:30:45'])
    expect(
      missingStatedValues(extractStatedValues('check the slot [10:30] is shown'), [
        'Verify the slot [11:45] is shown',
      ]),
    ).toEqual(['10:30'])
  })

  it('a long request of decade elisions, digit-led quotes and bracketed colons is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const units = ["'90s ", '[1:2:3:4:5:6:7] ', "'4K' ", '[10:30] ']
    const requests = units.map((unit) =>
      unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000),
    )
    requests.push(`[${':'.repeat(199_999)}`, `[${'1:'.repeat(99_999)}1`)
    for (const request of requests) {
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

describe('bracketed IPv6 hosts state nothing', () => {
  it('a bracketed IPv6 host in compressed or full form states nothing', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('open [fe80::1] and check 2 items')).toEqual(['2'])
    expect(extractStatedValues('open [2001:db8::1]:443 and check 2 items')).toEqual(['2'])
    expect(extractStatedValues('open [2001:db8:0:0:0:0:0:1]:443/cart and check 2 items')).toEqual([
      '2',
    ])
    expect(extractStatedValues('open [::ffff:192.0.2.1]:8080 and check 2 items')).toEqual(['2'])
  })
})

// A run that starts mid-line waits for its 2, and a step label counts only in label position.
describe('numbers after a colon or a sentence end, and mid-sentence step numbers', () => {
  it('a number stated after a colon or a sentence end is a stated value when no list follows it', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues('check the badge shows: 1. Then click checkout')).toEqual(['1'])
    expect(
      extractStatedValues('Check Quantity: 1. Then set it to 2. Then check Total: $40.'),
    ).toEqual(['1', '2', '$40'])
    expect(extractStatedValues('Is the count right? 1. Then click')).toEqual(['1'])
    expect(extractStatedValues('check the badge shows: 1) then click checkout')).toEqual(['1'])
    expect(extractStatedValues('check the cart says: (1) item')).toEqual(['1'])
    expect(
      missingStatedValues(extractStatedValues('check the badge shows: 1. Then click checkout'), [
        'Verify the badge shows 0',
        'Click checkout',
      ]),
    ).toEqual(['1'])
  })

  it('a list after a colon or a sentence starts only when its 2 follows, and a lowercase sentence stating 1 and then 2 is the known leftover', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues('Checkout test: 1. open the shop')).toEqual(['1'])
    expect(extractStatedValues('Checkout test: 1. Open the shop 2. Add 2 items')).toEqual([
      '1',
      '2',
    ])
    const leftover = extractStatedValues('Check quantity: 1. then set it to 2. then check the cart')
    expect(leftover).toEqual([])
    expect(missingStatedValues(leftover, ['Set the quantity', 'Verify the cart is shown'])).toEqual(
      [],
    )
  })

  it('a step number stated mid-sentence is a stated value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues('check the wizard is on step 2. Then click Next')).toEqual(['2'])
    expect(extractStatedValues('check the wizard heading says Step 2: Payment')).toEqual(['2'])
    expect(extractStatedValues('check the progress bar shows step 2.')).toEqual(['2'])
    expect(extractStatedValues('go to step 3) and click Next')).toEqual(['3'])
    expect(extractStatedValues('check the title shows: Step 1. Then click Next')).toEqual(['1'])
    expect(
      extractStatedValues('Step 1: click Next. Step 2: check the progress bar shows step 3.'),
    ).toEqual(['3'])
    expect(
      missingStatedValues(extractStatedValues('check the wizard is on step 2. Then click Next'), [
        'Verify the wizard is on step 3',
        'Click Next',
      ]),
    ).toEqual(['2'])
  })

  it('a step label counts only from the start of the request, a line, a colon or a sentence, and a step number where the next label would go is the known leftover', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(extractStatedValues('Test the wizard Step 1: open it Step 2: click Next')).toEqual([
      '1',
      '2',
    ])
    expect(extractStatedValues('Step 1: open the shop Step 2. add items')).toEqual(['2'])
    const leftover = extractStatedValues(
      'Step 1: click Next. Step 2: check the wizard shows Step 3: Payment',
    )
    expect(leftover).toEqual([])
    expect(missingStatedValues(leftover, ['Verify the wizard shows Step 4: Payment'])).toEqual([])
  })

  it('a long request of held list starts and step labels is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const units = [
      ': 1. Then 2. Then ',
      ': 1. x ',
      '. Step 1: x ',
      ': 1. "a" 2. ',
      ': Step 1: "a" Step 2: ',
    ]
    for (const unit of units) {
      const request = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

describe('lists after a colon or a sentence state no list number', () => {
  it('a list after a colon or a sentence states no list number once its next marker follows, across a quoted value too', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('Checkout test: 1. click "Add to cart" 2. open the cart')).toEqual([
      'Add to cart',
    ])
    expect(
      extractStatedValues('Checkout test: 1. Open the shop 2. Add 2 items 3. Check the cart'),
    ).toEqual(['2'])
    expect(extractStatedValues('Test the cart. 1. Add 2 items 2. check the total')).toEqual(['2'])
    expect(extractStatedValues('Checkout test: 1) open the shop 2) add 2 items')).toEqual(['2'])
  })

  it('a step-labelled list after a colon, a sentence or a line break states no step number', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('Checkout test: Step 1: open the shop Step 2: add 2 items'),
    ).toEqual(['2'])
    expect(
      extractStatedValues('Test the wizard. Step 1: click "Next" Step 2: check the cart'),
    ).toEqual(['Next'])
    expect(extractStatedValues('Step 1: open the shop\nStep 2. add 2 items')).toEqual(['2'])
  })
})

// Held step headings, nested held starts and held paren runs.
describe('held list starts and step labels', () => {
  it('a held step label and its next label that each end a sentence are stated values until a third label follows, and a capitalized two-label step list is the known boundary', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const request =
      'check the title shows: Step 1. Then click Next and check it shows Step 2. Then click Pay'
    expect(extractStatedValues(request)).toEqual(['1', '2'])
    expect(
      extractStatedValues(
        'Check the heading: Step 1: Welcome. Click Next. Check the heading: Step 2: Payment.',
      ),
    ).toEqual(['1', '2'])
    expect(
      extractStatedValues(
        'Check the progress says: Step 1 - Cart. Then click Next and check it says Step 2 - Payment',
      ),
    ).toEqual(['1', '2'])
    expect(
      missingStatedValues(extractStatedValues(request), [
        'Verify the title shows Step 3',
        'Click Next',
        'Click Pay',
      ]),
    ).toEqual(['1', '2'])
    expect(
      extractStatedValues('Checkout test: Step 1: Open the shop Step 2: Add 2 items'),
    ).toEqual(['1', '2'])
    expect(extractStatedValues('Test the wizard. Step 1. Open it. Step 2. Click Next.')).toEqual([
      '1',
      '2',
    ])
  })

  it('a held 1 inside a numbered item never takes over the item list, so the next item number neither confirms it nor becomes a stated value', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const request =
      '1. check the badge shows: 1. Then add another item\n2. check the badge shows: 2. Then check out'
    expect(extractStatedValues(request)).toEqual(['1', '2'])
    expect(
      extractStatedValues(
        '1. open the cart\n2. check the badge shows: 1. Then add another item\n3. check the total says $40',
      ),
    ).toEqual(['1', '$40'])
    expect(extractStatedValues('1) open the shop. 1) add items 2) pay')).toEqual(['1'])
    expect(
      extractStatedValues('1. check the badge shows: 1. Then add another item\n2. Check out'),
    ).toEqual(['1'])
    expect(
      missingStatedValues(extractStatedValues(request), ['Verify the badge shows 0', 'Check out']),
    ).toEqual(['1', '2'])
  })

  it('a held step label inside a step-labelled item never takes over the item steps, so the next item label is not a stated value', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues(
        'Step 1: open the cart\nStep 2: check the title shows: Step 1. Then click Next\nStep 3: click Pay',
      ),
    ).toEqual(['1'])
    expect(
      extractStatedValues(
        'Step 1: open the cart\nStep 2: check the title shows: Step 1. Then click Next and it shows Step 2. Then\nStep 3: click Pay',
      ),
    ).toEqual(['1', '2'])
    expect(
      extractStatedValues('Step 1: check the title shows: Step 1. Then click Next\nStep 2: Click Pay'),
    ).toEqual(['1'])
    expect(
      extractStatedValues('Step 1. Check the title shows: Step 1. Then click Next. Step 2. Click Pay.'),
    ).toEqual(['1'])
  })

  it('a held 1) or (1) run whose markers are each followed by a capital letter is a stated value until its third marker follows, and a capitalized two-item paren list is the known boundary', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    expect(
      extractStatedValues(
        'Check the badge shows: 1) Then add one more and check it shows 2) Then check out',
      ),
    ).toEqual(['1', '2'])
    const request =
      'Check the badge says: (1) Then add one more and check it says (2) Then check out'
    expect(extractStatedValues(request)).toEqual(['1', '2'])
    expect(
      missingStatedValues(extractStatedValues(request), [
        'Verify the badge says (0)',
        'Add one more',
        'Check out',
      ]),
    ).toEqual(['1', '2'])
    expect(extractStatedValues('Checkout test: 1) Open the shop 2) Add 2 items')).toEqual([
      '1',
      '2',
    ])
    expect(extractStatedValues('Checkout test: (1) Open the shop (2) Add 2 items')).toEqual([
      '1',
      '2',
    ])
  })

  it('a capital then lowercase pair, three capitalized sentences, a lowercase paren pair and a number read as the next marker or label of a run after a held start are the known leftovers', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const capitalThenLowercase = extractStatedValues(
      'Check the badge shows: 1. Then set the quantity to 2. then check the cart',
    )
    expect(capitalThenLowercase).toEqual([])
    expect(
      missingStatedValues(capitalThenLowercase, ['Verify the badge shows 0', 'Check the cart']),
    ).toEqual([])
    expect(
      extractStatedValues(
        'check the title shows: Step 1. Then click Next and check it shows Step 2. then click Pay',
      ),
    ).toEqual([])
    expect(
      extractStatedValues('Check Quantity: 1. Then set it to 2. Then set it to 3. Then check the total'),
    ).toEqual([])
    expect(
      extractStatedValues(
        'check the title shows: Step 1. Then click Next. It shows Step 2. Then click Pay. It shows Step 3. Then pay',
      ),
    ).toEqual([])
    expect(
      extractStatedValues('Check the badge says: (1) and after adding check it says (2) items'),
    ).toEqual([])
    expect(
      extractStatedValues(
        'Check the badge shows: 1) then add one more and check it shows 2) then check out',
      ),
    ).toEqual([])
    expect(
      extractStatedValues('1. check the badge shows: 1. Then set it to 2. Then check out'),
    ).toEqual(['1'])
    expect(
      extractStatedValues(
        '1. open the cart\n2. check the badge shows: 1. Then set it to 3. Then check out',
      ),
    ).toEqual(['1'])
    expect(
      extractStatedValues('1. check the badge shows: 1) Then set it to 2. Then check out'),
    ).toEqual(['1'])
    expect(
      extractStatedValues(
        '1. check the badge shows: 1. then add one\n2. check the badge shows: 2. then check out',
      ),
    ).toEqual([])
    expect(
      extractStatedValues(
        'Step 1. Check the heading shows: Step 1 - Cart. Then go on to Step 2. Then pay',
      ),
    ).toEqual(['1'])
    expect(extractStatedValues('test: Step 1. Step 2 - Step 3.')).toEqual([])
  })

  it('a long request of held step headings, nested held starts and held paren runs is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const units = [
      ': Step 1. Then Step 2. Then ',
      '1. x: 1. Then\n2. y: 2. Then\n',
      ': 1) Then 2) Then ',
      ': (1) Then (2) Then ',
      'Step 1: a: Step 1. B\nStep 2: c\n',
    ]
    for (const unit of units) {
      const request = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

describe('a confirmed held list states no number', () => {
  it('a held step list states no step number once its third label follows or its labels do not each end a sentence', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('Test the wizard. Step 1. Open it. Step 2. Click Next. Step 3. Pay.'),
    ).toEqual([])
    expect(
      extractStatedValues(
        'Checkout test: Step 1: Open the shop Step 2: Add 2 items Step 3: Check the cart',
      ),
    ).toEqual(['2'])
    expect(
      extractStatedValues('Checkout test: Step 1: Open the shop Step 2: add 2 items'),
    ).toEqual(['2'])
  })

  it('a held 1) or (1) list states no list number once its third marker follows or its items start lowercase', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues('Checkout test: 1) Open the shop 2) Add 2 items 3) Check the cart'),
    ).toEqual(['2'])
    expect(
      extractStatedValues('Checkout test: (1) Open the shop (2) Add 2 items (3) Check the cart'),
    ).toEqual(['2'])
    expect(extractStatedValues('Test the cart. 1) open the shop 2) add 2 items')).toEqual(['2'])
  })
})

// Month-name dates beside list runs, the at-once reset in both passes and a restarted list's twin.
describe('month-name dates where a list marker would go', () => {
  it('a month-name date is a stated value even where the next list marker would go, and an item that ends in a month name before the next marker is the known boundary', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const heldStart = '1. check the badge shows: 1. Then check the date is Oct 2. Then check out'
    expect(extractStatedValues(heldStart)).toEqual(['1', 'Oct 2'])
    expect(
      extractStatedValues(
        '1. check the badge shows: 1. Then check the delivery date says October 2. Then pay',
      ),
    ).toEqual(['1', 'October 2'])
    const openRun = '1. open the calendar\n2. check the date shows Oct 3. Then click Next'
    expect(extractStatedValues(openRun)).toEqual(['Oct 3'])
    expect(
      extractStatedValues(
        '1. open the calendar\n2. check the date shows Oct 3. Then click Next\n3. close it',
      ),
    ).toEqual(['Oct 3'])
    expect(
      extractStatedValues('Check the badge shows: 1. then check the date is Oct 2. then pay'),
    ).toEqual(['1', 'Oct 2'])
    expect(
      missingStatedValues(extractStatedValues(heldStart), [
        'Verify the badge shows 1',
        'Verify the date is Oct 3',
        'Check out',
      ]),
    ).toEqual(['Oct 2'])
    expect(
      missingStatedValues(extractStatedValues(openRun), [
        'Open the calendar',
        'Verify the date shows Oct 4',
        'Click Next',
      ]),
    ).toEqual(['Oct 3'])
    expect(
      extractStatedValues(
        'Step 1: open the calendar\nStep 2: check the date shows Oct 3. Then click Next',
      ),
    ).toEqual(['Oct 3'])
    expect(extractStatedValues('1. pick the month March\n2. pay')).toEqual([])
    expect(extractStatedValues('1. pick the month March 2. pay')).toEqual(['March 2'])
    expect(extractStatedValues('1. pick the month March 2. pay 3. check out')).toEqual([
      'March 2',
      '3',
    ])
  })

  it('a long request of month-name days where the next list marker would go is checked in linear time', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const units = [
      '1. pick Oct 2. Then ',
      'x: 1. then the date is Sept. 2. then ',
      '1. a March\n2. b September 3. c\n',
    ]
    for (const unit of units) {
      const request = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
      expect(request).toHaveLength(200_000)

      const started = performance.now()
      const values = extractStatedValues(request)
      missingStatedValues([...values, '1'], [request])
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })

  it('an at-once 1 clears the held candidate in the list pass and in the step pass, so a stale held 1 is never confirmed by a later stated 2', async () => {
    const { extractStatedValues } = await load()
    expect(
      extractStatedValues(
        'Check the badge: 1. then add one\n1) open the cart 2) close it\ncheck it shows 2. then pay',
      ),
    ).toEqual(['1', '2'])
    expect(
      extractStatedValues(
        'Check the title: Step 1. then click\nStep 1: open it Step 2: close it\ncheck it shows Step 2. then pay',
      ),
    ).toEqual(['1', '2'])
  })

  it('a step list restarted at Step 1 inside the first item of an open step list states its 1, the step twin of a list restarted at 1', async () => {
    const { extractStatedValues } = await load()
    expect(extractStatedValues('Step 1: open the shop. Step 1: add items Step 2: pay')).toEqual([
      '1',
    ])
    expect(extractStatedValues('Step 1. Step 1. Step 2.')).toEqual(['1'])
  })
})

// A month-name day at a held start or the held next number clears the held run.
describe('a month-name day clears a held run', () => {
  it('a month-name day where a held run would start or take its next number clears the held run, so a later 2 never confirms a stale held 1, and a list after a colon whose first item states that day is the known boundary', async () => {
    const { extractStatedValues, missingStatedValues } = await load()
    const dayAtNext =
      'Check the badge shows: 1. Then check the date is Oct 2. Then set it to 2. then pay'
    const dayAtStart =
      'Check the counter: 1) Then set the delivery date to Oct. 1. Then check the counter shows 2) and pay'
    expect(extractStatedValues(dayAtNext)).toEqual(['1', 'Oct 2', '2'])
    expect(extractStatedValues(dayAtStart)).toEqual(['1', 'Oct. 1', '2'])
    expect(
      missingStatedValues(extractStatedValues(dayAtNext), [
        'Verify the badge shows 0',
        'Verify the date is Oct 2',
        'Set the quantity to 5',
        'Click pay',
      ]),
    ).toEqual(['1'])
    expect(
      missingStatedValues(extractStatedValues(dayAtStart), [
        'Verify the counter shows 1',
        'Set the delivery date to Oct. 1',
        'Verify the counter shows 7',
        'Click pay',
      ]),
    ).toEqual(['2'])
    expect(
      missingStatedValues(extractStatedValues(dayAtNext), [
        'Verify the badge shows 1',
        'Verify the date is Oct 2',
        'Set the quantity to 2',
        'Click pay',
      ]),
    ).toEqual([])
    expect(
      extractStatedValues('Checkout test: 1. pick the delivery date Oct 2. then 2. pay'),
    ).toEqual(['1', 'Oct 2', '2'])
  })
})
