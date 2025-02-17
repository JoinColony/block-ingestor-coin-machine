const ethers = require("ethers");
const coinMachineFactory = require("./abi/coinMachineFactoryABI.json");
const whitelist = require("./abi/whitelistABI.json");
const coinMachine = require("./abi/coinMachineABI.json");
const {
  handleAgreementSigned,
  handleUserApproved,
} = require("./handlers/whitelist.js");
const {
  handleCoinMachineInitialised,
  handleCoinMachineStateSet,
  handleTokensBought,
} = require("./handlers/coinMachine.js");

const { output, poorMansGraphQL } = require("./utils");

const WhitelistEvents = {
  'UserApproved': handleUserApproved,
  'AgreementSigned': handleAgreementSigned,
}

const CoinMachineEvents = {
  'CoinMachineInitialised': handleCoinMachineInitialised,
  'CoinMachineStateSet': handleCoinMachineStateSet,
  'TokensBought': handleTokensBought,
}

const fetchExistingWhitelists = async () => {
  const query = {
    operationName: "ListWhitelistsQuery",
    query: `
        query ListWhitelistsQuery {
          listWhitelists {
          items {
            id
          }
        }
      }
    `,
  };
  try {
    const { body } = await poorMansGraphQL(query);
    const result = JSON.parse(body);
    console.log(result, 'result');
    return result.data.listWhitelists.items;
  } catch (error) {
    console.log(error);
    // silent error
  }
}

const fetchExistingCoinMachines = async () => {
  const query = {
    operationName: "ListSalesQuery",
    query: `
        query ListSalesQuery {
          listSales {
          items {
            coinMachineAddress
          }
        }
      }
    `,
  };
  try {
    const { body } = await poorMansGraphQL(query);
    const result = JSON.parse(body);
    return result.data.listSales.items;
  } catch (error) {
    console.log(error);
    // silent error
  }
}

const subsribeToWhitelist = async (whitelistAddress, provider) => {
  try {
    const contract = await new ethers.Contract(whitelistAddress, whitelist.abi, provider);
    contract.on('*', async(event) => {
      const parsed = contract.interface.parseLog(event);
      const handler =  WhitelistEvents[event.event];
      if (!handler) return;
      const query = await handler(parsed.args, whitelistAddress);
      try {
        await poorMansGraphQL(query);
        output(`Database updated after event: ${event.event}`);
      } catch (error) {
        console.log(error);
        // silent error
      }
    });

  } catch (error) {
    console.error(error);
  }
}

const subsribeToCoinMachine = async (coinMachineAddress, provider) => {
  try {
    const contract = await new ethers.Contract(coinMachineAddress, coinMachine.abi, provider);
    contract.on('*', async(event) => {
      const parsed = contract.interface.parseLog(event);
      const handler = CoinMachineEvents[event.event];
      if (!handler) return;
      const queries = await handler(parsed.args, coinMachineAddress, contract);
      try {
        Promise.all(queries.map((query) => poorMansGraphQL(query)));
        output(`Database updated after event: ${event.event}`);
      } catch (error) {
        console.log(error);
        // silent error
      }
    });

  } catch (error) {
    console.error(error);
  }
}

(async () => {
  const jsonRpcUrl = process.env.RPC_URL || "http://localhost:8545";
  const provider = new ethers.providers.JsonRpcProvider(jsonRpcUrl);
  const whitelistContracts = []; // Fetch from db and subsribe

  const coinmachineFactoryAddress = process.argv[2];
  try {
    const contract = await new ethers.Contract(coinmachineFactoryAddress, coinMachineFactory.abi, provider);
    const existingWhitelists = await fetchExistingWhitelists();
    await Promise.all((existingWhitelists || []).map(async (w) => {
      await subsribeToWhitelist(w.id, provider);
    }));

    const existingCoinMachines = await fetchExistingCoinMachines();
    await Promise.all((existingCoinMachines || []).map(async (w) => {
      if (w.coinMachineAddress) {
        await subsribeToCoinMachine(w.coinMachineAddress, provider);
      }
    }));

    contract.on('*', async(event) => {
      const parsed = contract.interface.parseLog(event);
      let query;
      if (parsed.name === "WhitelistDeployed") {
        const { whitelist: whitelistAddress, owner } = parsed.args;
        await subsribeToWhitelist(whitelistAddress, provider);
        const whitelistContract = await new ethers.Contract(whitelistAddress, whitelist.abi, provider);
        const agreementHash = await whitelistContract.agreementHash();
        const approvals = await whitelistContract.useApprovals();;
        query = {
          operationName: "CreateWhitelist",
          query: `
              mutation CreateWhitelist {
                createWhitelist(
                input: { id: "${whitelistAddress}", owner: "${owner}", agreementHash: "${agreementHash}", useApprovals: ${Boolean(
            approvals
          )} }
              ) {
                id
              }
            }
          `,
        };
      }
      if (parsed.name === "CoinMachineDeployed") {
        const { coinMachine, owner, agreementHash } = parsed.args;
        await subsribeToCoinMachine(coinMachine, provider);
        query = {
          operationName: "CreateCompanyAgreement",
          query: `
              mutation CreateCompanyAgreement {
                createCompanyAgreement(
                input: { coinMachineAddress: "${coinMachine}", userCompanyAgreementsId: "${owner}", agreementHash: "${agreementHash}" }
              ) {
                coinMachineAddress
              }
            }
          `,
        };
      }
      if (!query) return;
      try {
        await poorMansGraphQL(query);
        output(`Database updated after event ${parsed.name}`);
      } catch (error) {
        console.log(error);
        // silent error
      }
    });
} catch (error) {
    console.error(error);
}

})()
