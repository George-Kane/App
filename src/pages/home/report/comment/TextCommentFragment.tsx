import Str from 'expensify-common/lib/str';
import React, {memo} from 'react';
import type {StyleProp, TextStyle} from 'react-native';
import EmojiWithTooltip from '@components/EmojiWithTooltip';
import Text from '@components/Text';
import ZeroWidthView from '@components/ZeroWidthView';
import useLocalize from '@hooks/useLocalize';
import useTheme from '@hooks/useTheme';
import useThemeStyles from '@hooks/useThemeStyles';
import useWindowDimensions from '@hooks/useWindowDimensions';
import convertToLTR from '@libs/convertToLTR';
import * as DeviceCapabilities from '@libs/DeviceCapabilities';
import * as EmojiUtils from '@libs/EmojiUtils';
import variables from '@styles/variables';
import CONST from '@src/CONST';
import type {OriginalMessageSource} from '@src/types/onyx/OriginalMessage';
import type {Message} from '@src/types/onyx/ReportAction';
import RenderCommentHTML from './RenderCommentHTML';

type TextCommentFragmentProps = {
    /** The reportAction's source */
    source: OriginalMessageSource;

    /** The message fragment needing to be displayed */
    fragment: Message;

    /** Should this message fragment be styled as deleted? */
    styleAsDeleted: boolean;

    /** Should the comment have the appearance of being grouped with the previous comment? */
    displayAsGroup: boolean;

    /** Additional styles to add after local styles. */
    style: StyleProp<TextStyle>;

    /** Text of an IOU report action */
    iouMessage?: string;
};

function removeLineBreakAndEmojiTag(html: string) {
    const htmlWithoutLineBreak = Str.replaceAll(html, '<br />', '\n');
    const htmlWithoutEmojiOpenTag = Str.replaceAll(htmlWithoutLineBreak, '<emoji>', '');
    return Str.replaceAll(htmlWithoutEmojiOpenTag, '</emoji>', '');
}

/**
 * Split the string containing emoji into an array
 * @param html
 * @returns
 */
function getTextMatrix(text: string) {
    const html = text.replace(CONST.REGEX.EMOJIS, (match) => `<emoji>${match}</emoji>`);
    return html
        .split('<emoji>')
        .map((tx) => tx.split('</emoji>'))
        .reduce((a, b) => a.concat(b))
        .filter((tx) => Boolean(tx));
}

function TextCommentFragment({fragment, styleAsDeleted, source, style, displayAsGroup, iouMessage = ''}: TextCommentFragmentProps) {
    const theme = useTheme();
    const styles = useThemeStyles();
    const {html = '', text} = fragment;
    const {translate} = useLocalize();
    const {isSmallScreenWidth} = useWindowDimensions();

    // If the only difference between fragment.text and fragment.html is <br /> and the emoji tags
    // we render it as text, not as html.
    // This is done to render emojis with line breaks between them as text
    const differByLineBreaksAndEmojiOnly = removeLineBreakAndEmojiTag(html) === text;

    // Only render HTML if we have html in the fragment
    if (!differByLineBreaksAndEmojiOnly) {
        const editedTag = fragment.isEdited ? `<edited ${styleAsDeleted ? 'deleted' : ''}></edited>` : '';
        const htmlContent = styleAsDeleted ? `<del>${html}</del>` : html;

        const htmlWithTag = editedTag ? `${htmlContent}${editedTag}` : htmlContent;

        return (
            <RenderCommentHTML
                source={source}
                html={htmlWithTag}
            />
        );
    }

    const containsOnlyEmojis = EmojiUtils.containsOnlyEmojis(text);
    const textMatrix = getTextMatrix(convertToLTR(iouMessage || text));

    return (
        <Text style={[containsOnlyEmojis && styles.onlyEmojisText, styles.ltr, style]}>
            <ZeroWidthView
                text={text}
                displayAsGroup={displayAsGroup}
            />
            {textMatrix.map((tx) => {
                const isEmoji = EmojiUtils.containsOnlyEmojis(tx);
                return isEmoji ? (
                    <EmojiWithTooltip
                        emojiCode={tx}
                        style={[
                            containsOnlyEmojis ? styles.onlyEmojisText : undefined,
                            styles.ltr,
                            style,
                            styleAsDeleted ? styles.offlineFeedback.deleted : undefined,
                            !DeviceCapabilities.canUseTouchScreen() || !isSmallScreenWidth ? styles.userSelectText : styles.userSelectNone,
                        ]}
                    />
                ) : (
                    <Text
                        key={tx}
                        style={[
                            containsOnlyEmojis ? styles.onlyEmojisText : undefined,
                            styles.ltr,
                            style,
                            styleAsDeleted ? styles.offlineFeedback.deleted : undefined,
                            !DeviceCapabilities.canUseTouchScreen() || !isSmallScreenWidth ? styles.userSelectText : styles.userSelectNone,
                        ]}
                    >
                        {tx}
                    </Text>
                );
            })}
            {fragment.isEdited && (
                <>
                    <Text
                        style={[containsOnlyEmojis && styles.onlyEmojisTextLineHeight, styles.userSelectNone]}
                        dataSet={{[CONST.SELECTION_SCRAPER_HIDDEN_ELEMENT]: true}}
                    >
                        {' '}
                    </Text>
                    <Text
                        fontSize={variables.fontSizeSmall}
                        color={theme.textSupporting}
                        style={[styles.editedLabelStyles, styleAsDeleted && styles.offlineFeedback.deleted, style]}
                    >
                        {translate('reportActionCompose.edited')}
                    </Text>
                </>
            )}
        </Text>
    );
}

TextCommentFragment.displayName = 'TextCommentFragment';

export default memo(TextCommentFragment);
