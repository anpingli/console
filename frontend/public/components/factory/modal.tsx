import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import * as Modal from 'react-modal';
import * as PropTypes from 'prop-types';
import { Router } from 'react-router-dom';
import * as classNames from 'classnames';
import * as _ from 'lodash-es';

import store from '../../redux';
import { ButtonBar } from '../utils/button-bar';
import { history } from '../utils/router';

export const createModal: CreateModal = getModalContainer => {
  const modalContainer = document.getElementById('modal-container');
  const result = new Promise(resolve => {
    const closeModal = (e?: React.SyntheticEvent) => {
      if (e && e.stopPropagation) {
        e.stopPropagation();
      }
      ReactDOM.unmountComponentAtNode(modalContainer);
      resolve();
    };
    Modal.setAppElement(modalContainer);
    ReactDOM.render(getModalContainer(closeModal), modalContainer);
  });
  return {result};
};

export const createModalLauncher: CreateModalLauncher = (Component) => (props) => {
  const getModalContainer: GetModalContainer = (onClose) => {
    const _handleClose = (e: React.SyntheticEvent) => {
      onClose && onClose(e);
      props.close && props.close();
    };
    const _handleCancel = (e: React.SyntheticEvent) => {
      props.cancel && props.cancel();
      _handleClose(e);
    };

    return (
      <Provider store={store}>
        <Router {...{history, basename: window.SERVER_FLAGS.basePath}}>
          <Modal
            isOpen={true}
            contentLabel="Modal"
            onRequestClose={_handleClose}
            className={classNames('modal-dialog', props.modalClassName)}
            overlayClassName="co-overlay"
            shouldCloseOnOverlayClick={!props.blocking}>
            <Component {..._.omit(props, 'blocking', 'modalClassName') as any} cancel={_handleCancel} close={_handleClose} />
          </Modal>
        </Router>
      </Provider>
    );
  };
  return createModal(getModalContainer);
};

export const ModalTitle: React.SFC<ModalTitleProps> = ({children, className = 'modal-header'}) => <div className={className}><h4 className="modal-title">{children}</h4></div>;

export const ModalBody: React.SFC<ModalBodyProps> = ({children}) => (
  <div className="modal-body">
    <div className="modal-body-content">
      <div className="modal-body-inner-shadow-covers">{children}</div>
    </div>
  </div>
);


export const ModalFooter: React.SFC<ModalFooterProps> = ({message, errorMessage, inProgress, children}) => {
  return <ButtonBar className="modal-footer" errorMessage={errorMessage} infoMessage={message} inProgress={inProgress}>
    {children}
  </ButtonBar>;
};

export const ModalSubmitFooter: React.SFC<ModalSubmitFooterProps> = ({message, errorMessage, inProgress, cancel, submitText, cancelText, submitDisabled, submitButtonClass='btn-primary'}) => {
  const onCancelClick = e => {
    e.stopPropagation();
    cancel(e);
  };

  return <ModalFooter inProgress={inProgress} errorMessage={errorMessage} message={message}>
    <button type="button" onClick={onCancelClick} className="btn btn-default">{cancelText || 'Cancel'}</button>
    <button type="submit" className={classNames('btn', submitButtonClass)} disabled={submitDisabled} id="confirm-action">{submitText}</button>
  </ModalFooter>;
};

ModalSubmitFooter.propTypes = {
  cancel: PropTypes.func.isRequired,
  cancelText: PropTypes.node,
  errorMessage: PropTypes.string.isRequired,
  inProgress: PropTypes.bool.isRequired,
  message: PropTypes.string,
  submitText: PropTypes.node.isRequired,
  submitButtonClass: PropTypes.string,
  submitDisabled: PropTypes.bool,
};

export type GetModalContainer = (onClose: (e?: React.SyntheticEvent) => void) => React.ReactElement;

type CreateModal = (getModalContainer: GetModalContainer) => {result: Promise<any>};

export type CreateModalLauncherProps = {
  blocking?: boolean;
  modalClassName?: string;
};

export type ModalComponentProps = {
  cancel?: () => void;
  close?: () => void;
};

export type ModalTitleProps = {
  className?: string;
};

export type ModalBodyProps = {
  className?: string;
};

export type ModalFooterProps = {
  message?: string;
  errorMessage?: string;
  inProgress: boolean;
};

export type ModalSubmitFooterProps = {
  message?: string;
  errorMessage?: string;
  inProgress: boolean;
  cancel: (e: Event) => void;
  cancelText?: React.ReactNode;
  submitText: React.ReactNode;
  submitDisabled?: boolean;
  submitButtonClass?: string;
};

export type CreateModalLauncher = <P extends ModalComponentProps>(C: React.ComponentType<P>) =>
  (props: P & CreateModalLauncherProps) => {result: Promise<{}>};
