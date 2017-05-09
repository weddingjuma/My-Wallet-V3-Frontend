angular
  .module('walletApp')
  .controller('SendCtrl', SendCtrl);

function SendCtrl ($scope, AngularHelper, $log, Wallet, Alerts, currency, $uibModal, $uibModalInstance, $timeout, $state, $filter, $stateParams, $translate, paymentRequest, format, MyWalletHelpers, $q, $http, fees, smartAccount, options, Env) {
  Env.then(env => {
    $scope.rootURL = env.rootURL;
  });

  const COUNTRY_CODE = Wallet.my.wallet.accountInfo.countryCodeGuess;
  const FEE_ENABLED = MyWalletHelpers.guidToGroup(Wallet.my.wallet.guid) === 'b';
  const FEE_OPTIONS = (options.service_charge || {})[COUNTRY_CODE];
  const FEE_TO_MINERS = FEE_OPTIONS && FEE_OPTIONS.send_to_miner;
  $scope.AB_TEST_FEE = FEE_OPTIONS != null;

  window.FEE = FEE_OPTIONS;

  $scope.status = Wallet.status;
  $scope.settings = Wallet.settings;
  $scope.alerts = [];

  $scope.origins = [];
  $scope.originsLoaded = false;
  $scope.originLimit = 50;
  $scope.increaseLimit = () => $scope.originLimit += 50;

  $scope.sending = false;
  $scope.confirm = false;
  $scope.advanced = false;
  $scope.building = false;

  $scope.inputMetricTypes = ['qr', 'paste', 'uri', 'dropdown'];
  $scope.inputMetric = null;

  $scope.fiatCurrency = Wallet.settings.currency;
  $scope.btcCurrency = Wallet.settings.btcCurrency;
  $scope.isBitCurrency = currency.isBitCurrency;
  $scope.fromSatoshi = currency.convertFromSatoshi;
  $scope.format = currency.formatCurrencyForView;
  $scope.isValidPrivateKey = Wallet.isValidPrivateKey;
  $scope.satoshi = currency.bitCurrencies.filter((c) => c.code === 'satoshi')[0];

  $scope.transactionTemplate = {
    fee: 0,
    size: 0,
    note: '',
    from: null,
    surge: false,
    amount: null,
    maxAvailable: null,
    destinations: [null],
    satoshiPerByte: null,
    feeType: 'legacyCapped',
    fees: {lowerLimit: 0, legacyCapped: 0, priority: 0, priorityCap: 0},
    feesPerKb: {lowerLimit: 0, legacyCapped: 0, priority: 0, priorityCap: 0}
  };

  $scope.transaction = angular.copy($scope.transactionTemplate);

  $scope.paymentOnUpdate = (data) => {
    let tx = $scope.transaction;

    tx.fees = data.fees;
    tx.size = data.txSize;
    tx.feesPerKb = data.feesPerKb;
    tx.fee = $scope.advanced ? data.finalFee : tx.size * tx.fees[tx.feeType];
    tx.maxAvailable = $scope.advanced ? data.balance - tx.fee : data.sweepAmount;
    tx.satoshiPerByte = $scope.advanced ? tx.satoshiPerByte : tx.fees[tx.feeType];
    if (tx.maxAvailable < 0) tx.maxAvailable = 0;

    AngularHelper.$safeApply($scope);
  };

  $scope.paymentOnError = (error) => {
    if (error.error === 'ERR_FETCH_UNSPENT') {
      Alerts.displayError(error.error, true, $scope.alerts);
      $scope.failedToLoadUnspent = true;
    }
  };

  $scope.paymentOnMessage = (message) => {
    if (message && message.text) {
      Alerts.displayWarning(message.text, true, $scope.alerts);
    }
  };

  $scope.setPaymentHandlers = (payment) => {
    payment.on('update', $scope.paymentOnUpdate);
    payment.on('error', $scope.paymentOnError);
    payment.on('message', $scope.paymentOnMessage);
  };

  $scope.unsetPaymentHandlers = (payment) => {
    payment.removeListener('update', $scope.paymentOnUpdate);
    payment.removeListener('error', $scope.paymentOnError);
    payment.removeListener('message', $scope.paymentOnMessage);
  };

  $scope.payment = Wallet.my.wallet.createPayment();
  $scope.setPaymentHandlers($scope.payment);

  $scope.hasZeroBalance = (origin) => origin.balance === 0;
  $scope.close = () => $uibModalInstance.dismiss('');

  $scope.applyPaymentRequest = (paymentRequest, i) => {
    let destination = {
      address: paymentRequest.address || '',
      label: paymentRequest.address || '',
      type: 'External'
    };
    $scope.transaction.destinations[i] = destination;
    if (paymentRequest.amount) $scope.transaction.amount = paymentRequest.amount;
    if (paymentRequest.message) $scope.transaction.note = decodeURI(paymentRequest.message);

    $scope.setPaymentTo();
    $scope.setPaymentAmount();
  };

  $scope.reopenModal = () => {
    $timeout(() => $uibModal.open({
      templateUrl: 'partials/send.pug',
      windowClass: 'bc-modal initial',
      controller: 'SendCtrl',
      resolve: {paymentRequest}
    }), 500);
    $uibModalInstance.dismiss();
  };

  $scope.numberOfActiveAccountsAndLegacyAddresses = () => {
    let numAccts = Wallet.accounts().filter(a => !a.archived).length;
    let numAddrs = Wallet.legacyAddresses().filter(a => !a.archived).length;
    return numAccts + numAddrs;
  };

  $scope.send = () => {
    if ($scope.sending) return;

    $scope.sending = true;
    $scope.transaction.note = $scope.transaction.note.trim();

    Alerts.clear($scope.alerts);

    let paymentCheckpoint;
    const setCheckpoint = (payment) => {
      paymentCheckpoint = payment;
    };

    const transactionFailed = (message) => {
      $scope.sending = false;

      if (paymentCheckpoint) {
        $scope.unsetPaymentHandlers($scope.payment);
        $scope.payment = Wallet.my.wallet.createPayment(paymentCheckpoint);
        $scope.setPaymentHandlers($scope.payment);
        $scope.payment.build(FEE_TO_MINERS);
      }

      let msgText = typeof message === 'string' ? message : 'SEND_FAILED';
      if (msgText.indexOf('Fee is too low') > -1) msgText = 'LOW_FEE_ERROR';

      if (msgText.indexOf('Transaction Already Exists') > -1) {
        $uibModalInstance.close();
      } else {
        Alerts.displayError(msgText, false, $scope.alerts);
      }
    };

    const transactionSucceeded = (tx) => {
      $uibModalInstance.close('');
      $timeout(() => {
        $scope.$root.scheduleRefresh();
        $scope.sending = false;
        Wallet.beep();

        if ($scope.inputMetricTypes.indexOf($scope.inputMetric) > -1) {
          $scope.sendInputMetrics($scope.inputMetric);
        }

        let note = $scope.transaction.note;
        if (note !== '') Wallet.setNote({ hash: tx.txid }, note);

        if ($state.current.name !== 'wallet.common.transactions') {
          $state.go('wallet.common.transactions');
        }

        let message = MyWalletHelpers.tor() ? 'BITCOIN_SENT_TOR' : 'BITCOIN_SENT';
        Alerts.displaySentBitcoin(message);

        if ($scope.AB_TEST_FEE) {
          Wallet.api.pushTxStats(Wallet.my.wallet.guid, $scope.advanced);
        }
      });
    };

    const signAndPublish = (passphrase) => {
      return $scope.payment.sideEffect(setCheckpoint)
        .sign(passphrase).publish().payment;
    };

    Wallet.askForSecondPasswordIfNeeded().then(signAndPublish)
      .then(transactionSucceeded).catch(transactionFailed);
  };

  $scope.sendInputMetrics = (metric) => {
    let root = $scope.rootURL ? $scope.rootURL : '/';
    $http.get(`${root}event?name=wallet_web_tx_from_${metric}`);
  };

  $scope.getToLabels = () => {
    return $scope.transaction.destinations.filter(d => d != null);
  };

  $scope.getTransactionTotal = (includeFee) => {
    let tx = $scope.transaction;
    let fee = includeFee ? tx.fee : 0;
    return parseInt(tx.amount, 10) + parseInt(fee, 10);
  };

  $scope.amountsAreValid = () => {
    return $scope.transaction.from == null ||
    !isNaN($scope.transaction.amount) && $scope.transaction.amt > 0 ||
    $scope.transaction.maxAvailable - $scope.getTransactionTotal() >= 0;
  };

  $scope.checkForSameDestination = () => {
    if ($scope.sendForm == null) return;
    const transaction = $scope.transaction;
    transaction.destinations.forEach((dest, index) => {
      let match = false;
      if (dest != null) {
        match = transaction.from.index != null
          ? dest.index === transaction.from.index
          : dest.address === transaction.from.address;
      }
      $scope.sendForm['destinations' + index].$setValidity('isNotEqual', !match);
    });
  };

  $scope.hasAmountError = () => {
    let field = $scope.sendForm.amount;
    let fiatField = $scope.sendForm.fiatAmount;
    let fieldError = (fiatField.$touched || field.$touched) && (fiatField.$invalid || field.$invalid);
    let notEnoughFunds = !$scope.amountsAreValid();
    return fieldError || notEnoughFunds;
  };

  $scope.$watch('transaction.destinations', (destinations) => {
    destinations.forEach((dest, index) => {
      if (dest == null) return;
      let valid = dest.index == null ? Wallet.isValidAddress(dest.address) : true;
      $scope.sendForm['destinations' + index].$setValidity('isValidAddress', valid);
      $scope.setPaymentTo();
    });
  }, true);

  let unwatchDidLoad = $scope.$watch('status.didLoadBalances', (didLoad) => {
    if (!didLoad || $scope.origins.length !== 0) return;
    $scope.transaction.from = smartAccount.getDefault();
    $scope.origins = smartAccount.getOptions();
    $scope.originsLoaded = true;

    if (paymentRequest.address) {
      $scope.inputMetric = 'uri';
      $scope.applyPaymentRequest(paymentRequest, 0);
    } else if (paymentRequest.toAccount != null) {
      $scope.transaction.destinations[0] = format.origin(paymentRequest.toAccount);
      $scope.transaction.from = paymentRequest.fromAddress;
    } else if (paymentRequest.fromAccount != null) {
      $scope.transaction.from = paymentRequest.fromAccount;
    }

    $scope.setPaymentFrom();
    $scope.setPaymentTo();
    $scope.setPaymentAmount();
    unwatchDidLoad();
  });

  $scope.useAll = () => {
    let tx = $scope.transaction;
    if (tx.maxAvailable == null) return;
    $scope.transaction.amount = $scope.transaction.maxAvailable;
    $scope.setPaymentAmount();
  };

  $scope.setPrivateKey = (priv) => {
    let field = $scope.sendForm.priv;
    priv ? field.$setTouched() : field.$setUntouched();
    $scope.transaction.priv = priv;
  };

  let lastOrigin;
  $scope.setPaymentFrom = () => {
    let tx = $scope.transaction;
    if (!tx.from) return;
    let origin = tx.from.index == null ? tx.from.address : tx.from.index;
    let fee = $scope.advanced ? tx.fee : undefined;
    if (origin === lastOrigin) return;
    lastOrigin = origin;
    $scope.setPrivateKey();
    $scope.payment.from(origin, fee);
  };

  $scope.setPaymentTo = () => {
    let destinations = $scope.transaction.destinations;
    if (destinations.some(d => d == null)) return;
    destinations = destinations.map(d => d.type === 'Accounts' ? d.index : d.address);
    $scope.payment.to(destinations);
  };

  $scope.setPaymentAmount = (reset) => {
    let amount = $scope.transaction.amount;
    if (isNaN(amount) || amount <= 0) return;
    let fee = $scope.advanced && !reset ? $scope.transaction.fee : undefined;
    let options = FEE_ENABLED && !$scope.advanced && !reset ? FEE_OPTIONS : null;
    $scope.payment.amount($scope.transaction.amount, fee, options);
  };

  $scope.setPaymentFee = (reset) => {
    let { fee, size, satoshiPerByte } = $scope.transaction;
    fee = $scope.advanced ? satoshiPerByte * size : fee;
    $scope.payment.fee(fee);
  };

  $scope.backToForm = () => {
    $scope.confirm = false;
  };

  $scope.advancedSend = () => {
    $scope.advanced = true;
    $scope.setPaymentAmount(true);
    $scope.setPaymentFee(true);
  };

  $scope.regularSend = () => {
    $scope.transaction.destinations.splice(1);
    $scope.advanced = false;
    $scope.setPaymentAmount();
  };

  $scope.goToConfirmation = () => {
    $scope.building = true;
    let modalErrors = ['cancelled', 'backdrop click', 'escape key press'];

    const handleNextStepError = error => {
      Alerts.clear($scope.alerts);
      let errorMsg = error.error ? $translate.instant(error.error, error) : errorMsg = error;
      if (modalErrors.indexOf(errorMsg) === -1) Alerts.displayError(errorMsg, false, $scope.alerts);
      if (error === 'cancelled') $scope.advancedSend();
      $scope.backToForm();
      AngularHelper.$safeApply($scope);
    };

    $scope.checkPriv()
      .then($scope.checkFee)
      .then($scope.finalBuild)
      .then(() => {
        $scope.confirm = true;
        if ($scope.AB_TEST_FEE) {
          Wallet.api.confirmationScreenStats(Wallet.my.wallet.guid);
        }
      })
      .catch(handleNextStepError)
      .finally(() => $scope.building = false);
  };

  $scope.checkPriv = (bip38pw) => {
    let tx = $scope.transaction;
    let fee = $scope.advanced ? tx.fee : undefined;
    let privErrors = { noMatch: 'PRIV_NO_MATCH', bip38: 'BIP38_ERROR', pw: 'INCORRECT_PASSWORD' };
    if (!tx.from.isWatchOnly) return $q.resolve();
    return $q.resolve(MyWalletHelpers.privateKeyCorrespondsToAddress(tx.from.address, tx.priv, bip38pw))
      .then(priv => {
        if (priv == null) return $q.reject(privErrors.noMatch);
        else $scope.payment.from(priv, fee);
      })
      .catch(e => {
        if (e === 'needsBip38') return Alerts.prompt('NEED_BIP38', { type: 'password' }).then($scope.checkPriv);
        else if (e === 'wrongBipPass') return $q.reject(privErrors.pw);
        else if (e !== 'PRIV_NO_MATCH') return $q.reject(privErrors.bip38);
        else return $q.reject(e);
      });
  };

  $scope.checkFee = () => {
    let tx = $scope.transaction;
    let surge = !$scope.advanced && tx.surge;
    let maximumFee = tx.maxAvailable + tx.fee - $scope.getTransactionTotal();

    const commitFee = (fee) => {
      if (fee) {
        if (fee > maximumFee) {
          let feeDiff = fee - tx.fee;
          tx.amount -= feeDiff;
          $scope.setPaymentAmount();
        }
        tx.fee = fee;
        $scope.setPaymentFee();
      }
    };

    const showFeeWarning = (suggestedFee) => {
      return fees.showFeeWarning(tx.fee, suggestedFee, maximumFee, surge);
    };

    let high = tx.feesPerKb.priorityCap;
    let mid = tx.feesPerKb.legacyCapped;
    let low = tx.feesPerKb.lowerLimit;
    console.log(`Fees { high: ${high}, mid: ${mid}, low: ${low} }`);

    if ($scope.advanced) {
      if (tx.fee > high) {
        return showFeeWarning(high).then(commitFee);
      } else if (tx.fee < low && $scope.advanced) {
        return showFeeWarning(low).then(commitFee);
      }
    } else {
      let feeUSD = currency.convertFromSatoshi(tx.fee, currency.currencies[0]);
      let feeRatio = tx.fee / tx.amount;
      if (feeUSD > 0.50 && tx.size > 1000 && feeRatio > 0.01) {
        return fees.showLargeTxWarning(tx.size, tx.fee).then(commitFee);
      } else if (surge) {
        return showFeeWarning(mid).then(commitFee);
      }
    }
    return $q.resolve();
  };

  $scope.handlePaste = (event, index) => {
    let destinations = [];
    $timeout(() => {
      event.target.value
        ? destinations.push({address: event.target.value})
        : destinations = $scope.transaction.destinations;
      const result = Wallet.parseBitcoinURL(destinations, index);
      $scope.transaction.destinations[index].address = result.address;
      $scope.transaction.amount = result.amount;
      index === 0 ? $scope.transaction.note = result.note : '';
      $scope.setPaymentAmount(); // keep
    }, 250);
  };

  $scope.finalBuild = () => $q((resolve, reject) => {
    $scope.payment.build(FEE_TO_MINERS).then(p => {
      p.blockchainFee = 0; // reset fee for next build
      resolve(p.transaction);
      return p;
    }).catch(r => {
      reject(r.error ? r.error.message || r.error : 'Error building transaction');
      return r.payment;
    });
  });
}
